const Parser = require('rss-parser');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { generateHTML } = require('./generator');

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
const MIN_NEWS_ITEMS = 8;
const REQUEST_TIMEOUT = 15000;
const CONCURRENT_LIMIT = 8;

// Load configs
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));

const parser = new Parser({ timeout: REQUEST_TIMEOUT });

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

// Fetch RSS feed
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
    
    const items = [];
    for (const item of (feed.items || []).slice(0, 20)) {
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      // Strictly only include items from the past 24 hours
      if (pubDate) {
        if (pubDate < cutoff) continue;
      } else {
        // No date available, skip to avoid old news
        continue;
      }
      
      const category = matchesKeywords(item.title);
      if (category) {
        items.push({
          title: item.title.trim(),
          link: item.link,
          source: source.name,
          date: pubDate.toISOString().split('T')[0],
          category
        });
      }
    }
    return items;
  } catch (err) {
    console.log(`[RSS Error] ${source.name}: ${err.message}`);
    return [];
  }
}

// Fetch web page and scrape headlines
// Note: scraped items have no date info, so we mark them as "today" 
// but only take top matches to reduce noise from old content
async function fetchScrape(source) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeout);
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    const items = [];
    $('a').each((_, el) => {
      const title = $(el).text().trim().replace(/\s+/g, ' ');
      let link = $(el).attr('href');
      
      // Stricter filtering: title must be 15-150 chars, no navigation links
      if (!title || title.length < 15 || title.length > 150) return;
      if (!link) return;
      if (link === '#' || link.startsWith('javascript:')) return;
      
      // Skip common navigation patterns
      if (/^(首页|关于|联系|登录|注册|more|home|about|contact)/i.test(title)) return;
      
      // Make relative URLs absolute
      if (link.startsWith('/')) {
        const urlObj = new URL(source.url);
        link = `${urlObj.origin}${link}`;
      }
      
      const category = matchesKeywords(title);
      if (category) {
        items.push({
          title,
          link,
          source: source.name,
          date: new Date().toISOString().split('T')[0],
          category
        });
      }
    });
    
    return items.slice(0, 5); // Limit per source to reduce old content noise
  } catch (err) {
    console.log(`[Scrape Error] ${source.name}: ${err.message}`);
    return [];
  }
}

// Deduplicate by title similarity
function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '').slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
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
  
  // Fetch all RSS sources
  const rssSources = [...sources.rss.chinese, ...sources.rss.english];
  console.log(`Fetching ${rssSources.length} RSS feeds...`);
  const rssResults = await asyncPool(CONCURRENT_LIMIT, rssSources, fetchRSS);
  
  // Fetch scrape sources
  const scrapeSources = [...sources.scrape.chinese, ...sources.scrape.english];
  console.log(`Scraping ${scrapeSources.length} websites...`);
  const scrapeResults = await asyncPool(CONCURRENT_LIMIT, scrapeSources, fetchScrape);
  
  // Collect all items
let allItems = [];
  for (const result of [...rssResults, ...scrapeResults]) {
    if (result.status === 'fulfilled' && result.value) {
      allItems.push(...result.value);
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
  const today = new Date().toISOString().split('T')[0];
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
}

main().catch(console.error);
