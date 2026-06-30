const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { generateHTML } = require('./generator');

// Return YYYY-MM-DD in Beijing time (Asia/Shanghai, UTC+8).
// We deliberately do NOT use new Date().toISOString() because that is UTC:
// when the GitHub Actions run lands in the Beijing early-morning window
// (which is the previous UTC day) a UTC filename would be off by one day.
function getEditionDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Simple translation via Google Translate (free, no API key)
async function translateToZh(text) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    return data[0].map(s => s[0]).join('');
  } catch {
    return null;
  }
}

function isEnglish(text) {
  const enChars = text.replace(/[^a-zA-Z]/g, '').length;
  return enChars / text.length > 0.5;
}

// Config
const MAX_NEWS_ITEMS = 12;
const REQUEST_TIMEOUT = 8000;   // 8s per request
const CONCURRENT_LIMIT = 8;    // concurrency (lowered to ease memory/parse pressure)
const GLOBAL_TIMEOUT = 7 * 60 * 1000; // 7-minute backstop (CI step hard-limit is 10m)
const MAX_BODY_BYTES = 1500000;       // cap each response BEFORE any sync parse, so a huge
                                      // page/feed can't block the event loop and stall every timer

// Load configs
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));

const parser = new Parser({ timeout: REQUEST_TIMEOUT });

// Utility: hard timeout wrapper for any promise
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]).catch(err => {
    console.log(`[Timeout] ${label}: ${err.message}`);
    return [];
  });
}

// Utility: delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: run promises with concurrency limit
async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = fn(item).then(r => { executing.splice(executing.indexOf(p), 1); return r; });
    results.push(p);
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  return Promise.allSettled(results);
}

// Check if title matches any keyword
// Uses word boundary matching for short English keywords to avoid false positives
function matchesKeywords(title, category) {
  if (!title) return false;
  
  // Skip low-quality content: aggregated titles, clickbait, soft articles, social news
  const skipPatterns = [
    // Aggregated news
    /晚报|早报|日报合集|快讯合集|氪星晚报|一周回顾|本周回顾|周报|morning brief|evening brief|daily roundup|weekly roundup|newsletter/i,
    // Clickbait / sensational
    /去世|死亡|离世|自杀|惊呆|震惊|崩溃|炸了|疯了|吓人|恐怖|细思极恐|万万没想到|竟然|居然/i,
    // Soft articles / PR / marketing
    /创业故事|创业一年|师兄弟|夫妻档|合伙人故事|独家专访创始人|从0到1|白手起家/i,
    // Lawsuits / social drama (not tech-focused)
    /起诉|被告|法院判决|离婚|出轨|丑闻|八卦/i,
    // Listicles / opinion pieces that are usually low quality
    /你不知道的|必看|盘点|排行榜|TOP\s*\d+|榜单/i,
    // Ads / promotions
    /优惠|折扣|促销|限时|免费领|薅羊毛|红包|补贴大战/i
  ];
  if (skipPatterns.some(p => p.test(title))) return null;
  
  const titleLower = title.toLowerCase();
  
  // Short keywords that need word boundary matching (<=4 chars or prone to false match)
  const needBoundary = new Set(['ai', 'llm', 'nlp', 'gpt', 'amr', 'agv', 'ros', 'agi']);
  
  // Check all categories if no specific category
  const categories = category ? [category] : Object.keys(keywords);
  
  for (const cat of categories) {
    const kw = keywords[cat];
    if (!kw) continue;
    const allKeywords = [...(kw.zh || []), ...(kw.en || [])];
    for (const keyword of allKeywords) {
      const kwLower = keyword.toLowerCase();
      if (needBoundary.has(kwLower)) {
        // Use word boundary regex for short keywords
        const regex = new RegExp(`\\b${kwLower}\\b`, 'i');
        if (regex.test(title)) return cat;
      } else {
        if (titleLower.includes(kwLower)) return cat;
      }
    }
  }
  return null;
}

// Fetch a URL as text with BOTH a time cap (AbortController) and a size cap.
// The size cap is the key fix: parsing an unbounded huge body runs synchronously
// (XML / HTML) and blocks the event loop, which stops every setTimeout timer
// (including the global backstop) from firing -> the CI step hard-times-out.
async function fetchText(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(accept ? { 'Accept': accept } : {})
      }
    });
    let text = await res.text();
    if (text.length > MAX_BODY_BYTES) text = text.slice(0, MAX_BODY_BYTES);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// --- Google News RSS search layer -------------------------------------------
// Instead of relying on each outlet's flaky native RSS/HTML (dead URLs, anti-bot
// pages, malformed XML), we query Google News' RSS search scoped to each outlet's
// domain (site:) plus a few topical keywords. Google News returns clean, standard
// RSS that parses reliably and covers virtually every outlet.

// Compact topical query terms per category + language (joined with OR).
const CATEGORY_TERMS = {
  ai:          { zh: ['人工智能', '大模型', 'AI', '生成式'],            en: ['AI', '"artificial intelligence"', 'LLM', '"machine learning"'] },
  robotics:    { zh: ['机器人', '人形机器人', '具身智能'],               en: ['robot', 'robotics', 'humanoid'] },
  application: { zh: ['无人配送', '仓储自动化', '机器人', '人工智能'],    en: ['"delivery robot"', '"warehouse automation"', 'robot', 'AI'] }
};

const GNEWS_PARAMS = {
  zh: 'hl=zh-CN&gl=CN&ceid=CN:zh',
  en: 'hl=en-US&gl=US&ceid=US:en'
};

// Obvious low-quality patterns to drop even when scoped (digests / ads / listicles).
const SKIP_TITLE = /晚报|早报|合集|周报|roundup|newsletter|盘点|榜单|促销|优惠|限时|免费领|薅羊毛/i;

// Flatten sources.json into a deduped list of outlets: { name, domain, category, lang }.
function flattenOutlets() {
  const groups = [
    { list: sources.rss.chinese,    lang: 'zh' },
    { list: sources.rss.english,    lang: 'en' },
    { list: sources.scrape.chinese, lang: 'zh' },
    { list: sources.scrape.english, lang: 'en' }
  ];
  const seen = new Set();
  const outlets = [];
  for (const g of groups) {
    for (const src of (g.list || [])) {
      let domain;
      try { domain = new URL(src.url).hostname.replace(/^www\./, ''); } catch { continue; }
      if (seen.has(domain)) continue;          // dedup outlets sharing a domain
      seen.add(domain);
      outlets.push({ name: src.name, domain, category: src.category || 'ai', lang: g.lang });
    }
  }
  return outlets;
}

// Query Google News RSS for one outlet, scoped to its domain + topical terms.
async function fetchGoogleNews(outlet) {
  try {
    const terms = (CATEGORY_TERMS[outlet.category] || CATEGORY_TERMS.ai)[outlet.lang];
    const query = `site:${outlet.domain} (${terms.join(' OR ')}) when:2d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${GNEWS_PARAMS[outlet.lang]}`;
    const xml = await fetchText(url, 'application/rss+xml, application/xml, text/xml, */*');
    if (!xml) return [];
    const feed = await parser.parseString(xml);
    if (!feed || !feed.items) return [];

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // last 48h
    const items = [];
    for (const item of feed.items.slice(0, 25)) {
      if (!item.title || SKIP_TITLE.test(item.title)) continue;
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (!pubDate || pubDate < cutoff) continue;
      // Google News titles look like "Headline - Source"; drop the trailing source.
      const title = item.title.replace(/\s+-\s+[^-]+$/, '').trim();
      if (title.length < 8) continue;
      const category = matchesKeywords(title) || outlet.category;
      items.push({ title, link: item.link, source: outlet.name, date: pubDate.toISOString().split('T')[0], category });
      if (items.length >= 5) break; // cap per outlet
    }
    return items;
  } catch (err) {
    console.log(`[GNews Error] ${outlet.name}: ${err.message}`);
    return [];
  }
}

// Deduplicate by title similarity (prefix match + word overlap)
function deduplicate(items) {
  const seen = [];
  return items.filter(item => {
    const key = item.title.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    const prefix = key.slice(0, 30);
    // Extract meaningful words (length > 3) for similarity check
    const words = new Set(item.title.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    for (const prev of seen) {
      // Exact prefix match
      if (prev.prefix === prefix) return false;
      // Word overlap: if 60%+ of words are shared, treat as duplicate
      if (words.size > 2 && prev.words.size > 2) {
        let overlap = 0;
        for (const w of words) {
          if (prev.words.has(w)) overlap++;
        }
        const similarity = overlap / Math.min(words.size, prev.words.size);
        if (similarity >= 0.6) return false;
      }
    }
    seen.push({ prefix, words });
    return true;
  });
}

// Score items for importance (simple heuristic)
function scoreItem(item) {
  let score = 0;
  const title = item.title.toLowerCase();
  // Boost for multiple keyword matches
  const allKeywords = [...keywords[item.category].zh, ...keywords[item.category].en];
  for (const kw of allKeywords) {
    if (title.includes(kw.toLowerCase())) score += 1;
  }
  // Boost for well-known sources
  const topSources = ['TechCrunch', 'MIT Technology Review', '36氪', '机器之心', 'The Verge', 'Reuters', 'Bloomberg', 'IEEE Spectrum', 'The Robot Report', '智东西', 'Robohub', '中国机器人网'];
  if (topSources.some(s => item.source.includes(s))) score += 2;
  return score;
}

// Main
async function main() {
  console.log(`[${new Date().toLocaleString()}] Starting news fetch...`);
  
  // Global timeout protection: force exit after 7 minutes
  const globalTimer = setTimeout(() => {
    console.error('GLOBAL TIMEOUT: Exceeded 7 minutes. Force exiting with success.');
    process.exit(0);
  }, GLOBAL_TIMEOUT);
  
  // Fetch every outlet via Google News search (overall 2.5-minute cap)
  const outlets = flattenOutlets();
  console.log(`Searching ${outlets.length} outlets via Google News...`);
  const newsResults = await withTimeout(
    asyncPool(CONCURRENT_LIMIT, outlets, fetchGoogleNews),
    150 * 1000,
    'All Google News searches'
  ) || [];

  // Collect all items
  let allItems = [];
  for (const result of (Array.isArray(newsResults) ? newsResults : [])) {
    if (result && result.status === 'fulfilled' && Array.isArray(result.value)) {
      allItems.push(...result.value);
    } else if (Array.isArray(result)) {
      allItems.push(...result);
    }
  }

  console.log(`Total raw items: ${allItems.length}`);
  
  // Deduplicate
  allItems = deduplicate(allItems);
  console.log(`After dedup: ${allItems.length}`);
  
  // Cross-day dedup: exclude news already published in recent days
  const outputDir = path.join(__dirname, 'output');
  const historyPath = path.join(outputDir, 'history.json');
  let publishedLinks = new Set();
  if (fs.existsSync(historyPath)) {
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      // Keep last 7 days of history
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      for (const [date, links] of Object.entries(history)) {
        if (date >= cutoffStr) {
          links.forEach(l => publishedLinks.add(l));
        }
      }
    } catch (e) { console.log('History read error, continuing without history'); }
  }
  const beforeFilter = allItems.length;
  allItems = allItems.filter(item => !publishedLinks.has(item.link));
  console.log(`After cross-day dedup: ${allItems.length} (removed ${beforeFilter - allItems.length} already published)`);
  
  // Score and sort
  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));
  
  // Take top items, ensuring category diversity
  const selected = [];
  const categoryCounts = { ai: 0, robotics: 0, application: 0 };
  
  // First pass: guarantee at least 3 robotics and 2 application items
  const minPerCategory = { ai: 0, robotics: 3, application: 2 };
  for (const [cat, min] of Object.entries(minPerCategory)) {
    const catItems = allItems.filter(i => i.category === cat);
    for (let i = 0; i < Math.min(min, catItems.length); i++) {
      selected.push(catItems[i]);
      categoryCounts[cat]++;
    }
  }
  
  // Second pass: fill remaining slots by score
  for (const item of allItems) {
    if (selected.length >= MAX_NEWS_ITEMS) break;
    if (selected.includes(item)) continue;
    selected.push(item);
    categoryCounts[item.category]++;
  }
  
  // Translate English titles to Chinese
  console.log('Translating English titles...');
  for (const item of selected) {
    if (isEnglish(item.title)) {
      const zhTitle = await translateToZh(item.title);
      if (zhTitle) {
        item.titleZh = zhTitle;
      }
    }
  }
  
  console.log(`Selected ${selected.length} items: AI=${categoryCounts.ai}, Robotics=${categoryCounts.robotics}, Application=${categoryCounts.application}`);
  
  // Generate output
  const today = getEditionDate();
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  
  const outputPath = path.join(outputDir, `${today}.html`);
  const html = generateHTML(selected, today);
  fs.writeFileSync(outputPath, html, 'utf8');
  
  // Update manifest
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest = [];
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  if (!manifest.includes(today)) {
    manifest.push(today);
    manifest.sort();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  // Update history (record published links for cross-day dedup)
  let history = {};
  if (fs.existsSync(historyPath)) {
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) {}
  }
  history[today] = selected.map(item => item.link);
  // Clean up entries older than 7 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  for (const date of Object.keys(history)) {
    if (date < cutoffStr) delete history[date];
  }
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');

  console.log(`\nDone! Output: ${outputPath}`);
  console.log(`Open in browser: file:///${outputPath.replace(/\\/g, '/')}`);
  
  clearTimeout(globalTimer);
}

main().catch(console.error);