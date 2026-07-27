// Regression test: guards against keyword false-matches (e.g. SLAM inside "Islamist").
// Run:  node test-keywords.js    (exit 0 = pass, 1 = fail)
const fs = require('fs');
const keywords = JSON.parse(fs.readFileSync(__dirname + '/keywords.json', 'utf8'));
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matchesKeywords(title) {
  if (!title) return null;
  const titleLower = title.toLowerCase();
  for (const cat of Object.keys(keywords)) {
    for (const keyword of [...(keywords[cat].zh || []), ...(keywords[cat].en || [])]) {
      const kwLower = keyword.toLowerCase();
      const isLatin = /[a-z]/.test(kwLower) && !/[一-龥]/.test(kwLower);
      if (isLatin) {
        if (new RegExp(`(^|[^a-z0-9])${escapeRe(kwLower)}([^a-z0-9]|$)`, 'i').test(titleLower)) return cat;
      } else if (titleLower.includes(kwLower)) return cat;
    }
  }
  return null;
}
// Titles that MUST NOT match any keyword (off-topic / trap words):
const shouldNotMatch = [
  'Berlin police hunt Islamist suspect in Berlin Pride attack',
  'German interior minister says signs point to Islamist attack at Berlin Pride event',
  'Local brain surgery breakthrough announced at hospital',   // "brain" must not hit "ai"
  'New airport terminal opens in Chicago',                     // "air" must not hit "ai"
  'Stock market closes higher amid trade optimism'
];
// Titles that MUST still match (real AI/robotics news):
const shouldMatch = [
  'New SLAM algorithm improves robot navigation',
  'OpenAI releases GPT-5.6 with better reasoning',
  '宇树发布新款人形机器人',
  'ChatGPT adds a new voice mode',
  '英伟达AI芯片需求旺盛'
];
let fail = 0;
for (const t of shouldNotMatch) { const m = matchesKeywords(t); if (m) { console.error('FAIL (should NOT match):', JSON.stringify(t), '->', m); fail++; } }
for (const t of shouldMatch) { const m = matchesKeywords(t); if (!m) { console.error('FAIL (should match):', JSON.stringify(t)); fail++; } }
if (fail) { console.error(`\n${fail} keyword test(s) failed.`); process.exit(1); }
console.log('All keyword tests passed.');
