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
const REQUEST_TIMEOUT = 10000;
const CONCURRENT_LIMIT = 5;

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
function matchesKeywords(title, category) {
  if (!title) return false;
  const titleLower = title.toLowerCase();
  
  // Check all categories if no specific category
  const categories = category ? [category] : Object.keys(keywords);
  
  for (const cat of categories) {
    const kw = keywords[cat];
    if (!kw) continue;
    const allKeywords = [...(kw.zh || []), ...(kw.en || [])];
    for (const keyword of allKeywords) {
      if (titleLower.includes(keyword.toLowerCase())) return cat;
    }
  }
  return null;
}

// Fetch RSS feed
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const items = [];
    for (const item of (feed.items || []).slice(0, 20)) {
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      // Only include items from today or yesterday (for early morning runs)
      if (pubDate) {
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        if (pubDate < yesterday) continue;
      }
      
      const category = matchesKeywords(item.title);
      if (category) {
        items.push({
          title: item.title.trim(),
          link: item.link,
          source: source.name,
          date: pubDate ? pubDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
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
      const title = $(el).text().trim();
      let link = $(el).attr('href');
      
      if (!title || title.length < 10 || title.length > 200) return;
      if (!link) return;
      
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
    
    return items.slice(0, 10); // Limit per source
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
  const outputDir = path.join(__dirname, 'output');
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

  console.log(`\nDone! Output: ${outputPath}`);
  console.log(`Open in browser: file:///${outputPath.replace(/\\/g, '/')}`);
}

main().catch(console.error);