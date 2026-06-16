const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const parser = new Parser({ timeout: 15000 });

async function checkRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const count = (feed.items || []).length;
    return { name: source.name, url: source.url, status: 'OK', items: count };
  } catch (err) {
    return { name: source.name, url: source.url, status: 'FAIL', error: err.message };
  }
}

async function checkScrape(source) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(timeout);
    return { name: source.name, url: source.url, status: res.ok ? 'OK' : 'FAIL', code: res.status };
  } catch (err) {
    return { name: source.name, url: source.url, status: 'FAIL', error: err.message };
  }
}

async function main() {
  console.log('=== RSS Sources ===\n');
  const allRSS = [...sources.rss.chinese, ...sources.rss.english];
  for (const s of allRSS) {
    const r = await checkRSS(s);
    const icon = r.status === 'OK' ? '✓' : '✗';
    const detail = r.status === 'OK' ? `${r.items} items` : r.error;
    console.log(`${icon} [${r.name}] ${detail}`);
  }

  console.log('\n=== Scrape Sources ===\n');
  const allScrape = [...sources.scrape.chinese, ...sources.scrape.english];
  for (const s of allScrape) {
    const r = await checkScrape(s);
    const icon = r.status === 'OK' ? '✓' : '✗';
    const detail = r.status === 'OK' ? `HTTP ${r.code}` : (r.error || `HTTP ${r.code}`);
    console.log(`${icon} [${r.name}] ${detail}`);
  }
}

main();