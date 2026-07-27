const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { generateHTML } = require('./generator');

// Return YYYY-MM-DD in Beijing time (Asia/Shanghai, UTC+8).
function getEditionDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Free Google Translate (no API key). Used for English titles + summaries.
async function translateToZh(text) {
  if (!text) return null;
  try {
    const clipped = text.slice(0, 400);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(clipped)}`;
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
const MAX_NEWS_ITEMS = 18;      // overall safety cap (per-category caps drive the real size)
const ZH_RATIO = 0.7;           // Chinese content must be >= 70%
const REQUEST_TIMEOUT = 8000;
const CONCURRENT_LIMIT = parseInt(process.env.CONC || '12', 10);
const SOURCE_CAP = 2;           // max items per outlet, so coverage spreads across many sources
const GLOBAL_TIMEOUT = 7 * 60 * 1000;
const MAX_BODY_BYTES = 1500000;

const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const keywords = JSON.parse(fs.readFileSync(path.join(__dirname, 'keywords.json'), 'utf8'));

const parser = new Parser({ timeout: REQUEST_TIMEOUT });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]).catch(err => {
    console.log(`[Timeout] ${label}: ${err.message}`);
    return [];
  });
}

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

// ---- Quality / anti-marketing filters -------------------------------------
const SKIP_PATTERNS = [
  /晚报|早报|日报合集|快讯合集|氪星晚报|一周回顾|本周回顾|周报|早知道|速览|一图看懂|一图读懂|新闻早餐|资讯早餐|夜读|简报|the download|morning brief|evening brief|daily roundup|weekly roundup|newsletter|每日一图/i,
  /去世|死亡|离世|自杀|惊呆|震惊|崩溃|炸了|疯了|吓人|恐怖|细思极恐|万万没想到|竟然|居然/i,
  /创业故事|创业一年|师兄弟|夫妻档|合伙人故事|独家专访创始人|从0到1|白手起家/i,
  /起诉|被告|法院判决|离婚|出轨|丑闻|八卦/i,
  /你不知道的|必看|盘点|排行榜|TOP\s*\d+|榜单|合集/i,
  /优惠|折扣|促销|限时|免费领|薅羊毛|红包|补贴大战|预售|首销|秒杀|领券|带货|种草|大促|好物|值得买/i,
  /广告|赞助|推广|软文|白皮书下载|报名|招聘|活动预告|直播预告|沙龙|峰会|大会|颁奖|评选/i,
  /sponsored|presented by|advertisement|\bdeal[s]?\b|discount|coupon|giveaway|\d+%\s*off|black friday|cyber monday|webinar|register now|sign up|whitepaper/i,
  /标签_|_标签|专题页|频道页|_网易出品|_腾讯网|资讯列表|新闻汇总|_专栏|专区$|栏目$|出品$/,
  /我花\d|我买了|我花了|我试了|我用了|我带着|亲测|开箱|结果它|真香|翻车|踩坑|吐槽|夹子音|陪我聊|你敢信|绝了|离谱|逼疯|种草|安利|花了\d+元|买了台|买了个/,
  /恐袭|恐怖袭击|枪击案|爆炸案|凶杀|谋杀案|命案|遇害|遇难|绑架|人质|难民|地震|洪灾|洪水|台风|飓风|山火|坠机|空难|骚乱|大选|竞选|弹劾|球赛|世界杯|奥运会|票房|演唱会|绯闻|婚变|涨停|跌停|龙虎榜|沪指|深指|北向资金/,
  /\bislamist\b|\bterror(ism|ist)?\b|\bshooting\b|\bgunman\b|\bhostage\b|\bmissile\b|\brefugee\b|\bearthquake\b|\bwildfire\b|\bworld cup\b|\bolympic|box office|\bpride (parade|event|attack)\b/i
];
function isLowQuality(title) {
  if (!title) return true;
  return SKIP_PATTERNS.some(p => p.test(title));
}

function matchesKeywords(title, category) {
  if (!title) return null;
  const titleLower = title.toLowerCase();
  const needBoundary = new Set(['ai', 'llm', 'nlp', 'gpt', 'amr', 'agv', 'ros', 'agi']);
  const categories = category ? [category] : Object.keys(keywords);
  for (const cat of categories) {
    const kw = keywords[cat];
    if (!kw) continue;
    const allKeywords = [...(kw.zh || []), ...(kw.en || [])];
    for (const keyword of allKeywords) {
      const kwLower = keyword.toLowerCase();
      if (needBoundary.has(kwLower)) {
        if (new RegExp(`\\b${kwLower}\\b`, 'i').test(title)) return cat;
      } else if (titleLower.includes(kwLower)) {
        return cat;
      }
    }
  }
  return null;
}

// Strip leading clock time / trailing column tag / bracket chars. Otherwise keep verbatim.
function cleanTitle(t) {
  if (!t) return '';
  let s = String(t).trim();
  s = s.replace(/^\d{1,2}[:：]\d{2}([:：]\d{2})?\s*/, '');      // leading clock time
  s = s.replace(/\s*[|｜丨]\s*[^|｜丨]{1,12}\s*$/, '');           // trailing column tag e.g. "| 极客早知道"
  s = s.replace(/[【】「」『』［］]/g, '');                            // drop bracket chars, keep inner text
  s = s.replace(/^[\s·|｜丨、,，:：]+/, '').replace(/\s+$/, '');    // tidy edges
  return s.trim();
}

// Reduce a raw description to ONE clean, complete sentence that fits a card.
function cleanSummary(raw) {
  if (!raw) return '';
  let s = String(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^.{0,40}?(消息|报道|讯)[，,]\s*/, '');
  s = s.replace(/(作者|编辑|编译|策划|校对|责编|来源|图源|文)\s*[|｜丨:：\/]\s*[^\s，。|｜丨:：]{1,6}/g, ' ');
  s = s.replace(/^(智东西|36氪|硬氪|量子位|机器之心|钛媒体|IT之家|界面新闻|第一财经|新华社|新华网)\s*/, '');
  s = s.replace(/^[\s|｜丨·、,，]+/, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cjk = s.search(/[。！？]/);
  if (cjk >= 0) {
    s = s.slice(0, cjk + 1);
  } else {
    const en = s.match(/^.*?[.!?](?=\s|$)/);
    if (en) s = en[0].trim();
    else s = s + '。';
  }
  if (s.length > 120) {
    let cut = s.slice(0, 120);
    const lp = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf(','), cut.lastIndexOf('、'));
    if (lp > 60) cut = cut.slice(0, lp);
    s = cut.replace(/[，,、\s]+$/, '') + '…';
  }
  s = s.replace(/[.．。…]{2,}$/, '…');
  return s.trim();
}

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

const CATEGORY_TERMS = {
  ai:          { zh: ['人工智能', '大模型', 'AI', '生成式'],            en: ['AI', '"artificial intelligence"', 'LLM', '"machine learning"'] },
  robotics:    { zh: ['机器人', '人形机器人', '具身智能'],               en: ['robot', 'robotics', 'humanoid'] },
  application: { zh: ['无人配送', '仓储自动化', '机器人', '人工智能'],    en: ['"delivery robot"', '"warehouse automation"', 'robot', 'AI'] }
};
const GNEWS_PARAMS = { zh: 'hl=zh-CN&gl=CN&ceid=CN:zh', en: 'hl=en-US&gl=US&ceid=US:en' };

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
      if (seen.has(domain)) continue;
      seen.add(domain);
      outlets.push({ name: src.name, url: src.url, domain, category: src.category || 'ai', lang: g.lang });
    }
  }
  return outlets;
}

const cutoffMs = () => new Date(Date.now() - 24 * 60 * 60 * 1000); // strict past 24h

async function fetchNativeRSS(outlet, cap) {
  try {
    const xml = await fetchText(outlet.url, 'application/rss+xml, application/xml, text/xml, */*');
    if (!xml) return [];
    const feed = await parser.parseString(xml);
    if (!feed || !feed.items) return [];
    const cutoff = cutoffMs();
    const items = [];
    for (const item of feed.items.slice(0, 40)) {
      if (!item.title || isLowQuality(item.title)) continue;
      const pub = item.isoDate || item.pubDate;
      const pubDate = pub ? new Date(pub) : null;
      if (!pubDate || isNaN(pubDate) || pubDate < cutoff) continue;
      const category = matchesKeywords(item.title);
      if (!category) continue;
      items.push({
        title: cleanTitle(item.title), link: item.link, source: outlet.name,
        lang: outlet.lang, category, pubDate: pubDate.toISOString(),
        summary: cleanSummary(item.contentSnippet || item.content)
      });
      if (items.length >= (cap || 5)) break;
    }
    return items;
  } catch (err) {
    console.log(`[Native RSS] ${outlet.name}: ${err.message}`);
    return [];
  }
}

async function fetchGoogleNews(outlet, cap) {
  try {
    const terms = (CATEGORY_TERMS[outlet.category] || CATEGORY_TERMS.ai)[outlet.lang];
    const query = `site:${outlet.domain} (${terms.join(' OR ')}) when:1d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${GNEWS_PARAMS[outlet.lang]}`;
    const xml = await fetchText(url, 'application/rss+xml, application/xml, text/xml, */*');
    if (!xml) return [];
    const feed = await parser.parseString(xml);
    if (!feed || !feed.items) return [];
    const cutoff = cutoffMs();
    const items = [];
    for (const item of feed.items.slice(0, 25)) {
      if (!item.title) continue;
      const raw = item.title.replace(/\s+-\s+[^-]+$/, '');   // drop trailing " - Source"
      if (isLowQuality(raw)) continue;                       // check digests/ads on raw title
      const title = cleanTitle(raw);
      if (title.length < 8) continue;
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (!pubDate || isNaN(pubDate) || pubDate < cutoff) continue;
      const category = matchesKeywords(title);
      if (!category) continue;
      items.push({
        title, link: item.link, source: outlet.name, lang: outlet.lang,
        category, pubDate: pubDate.toISOString(), summary: ''
      });
      if (items.length >= (cap || 5)) break;
    }
    return items;
  } catch (err) {
    console.log(`[GNews] ${outlet.name}: ${err.message}`);
    return [];
  }
}

// Native RSS (real summaries) and Google News (broad coverage) in parallel; merge,
// preferring the native copy of a link. Parallel keeps per-outlet cost ~one request.
async function fetchOutlet(outlet) {
  const cap = outlet.lang === 'zh' ? 6 : 4;
  const [native, gnews] = await Promise.all([fetchNativeRSS(outlet, cap), fetchGoogleNews(outlet, cap)]);
  const byLink = new Map();
  [...native, ...gnews].forEach(it => { if (it && it.link && !byLink.has(it.link)) byLink.set(it.link, it); });
  return Array.from(byLink.values()).slice(0, cap);
}

// ---- Summary enrichment: resolve link to the real article, read meta description ----
function pickMetaDesc(html) {
  const pats = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)/i
  ];
  for (const p of pats) { const m = html.match(p); if (m && m[1].trim().length > 10) return m[1].trim(); }
  return '';
}

async function resolveGoogleNewsUrl(url) {
  const m = url.match(/articles\/([^?]+)/);
  if (!m) return null;
  const id = m[1];
  const page = await fetchText('https://news.google.com/rss/articles/' + id, 'text/html');
  const sg = page.match(/data-n-a-sg="([^"]+)"/);
  const ts = page.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts[1]), sg[1]]);
  const payload = JSON.stringify([[['Fbv4je', inner]]]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0' },
      body: 'f.req=' + encodeURIComponent(payload)
    });
    const txt = await res.text();
    const um = txt.match(/https?:\/\/[^\s"\\]+/);
    return um ? um[0] : null;
  } finally { clearTimeout(timer); }
}

// Site-wide taglines that some pages expose as og:description (not article summaries).
const GENERIC_DESC = /官方网站|7[xX×]24|为用户提供|致力于成为|全媒体|新闻网站|提供.{0,8}资讯|一站式|下载客户端|品质源于|comprehensive.{0,20}coverage|aggregated from sources/i;

// ---- Optional AI summarization (Zhipu GLM / OpenAI-compatible) -------------
// Set ZHIPU_API_KEY to enable AI one-sentence summaries (free model glm-4-flash).
// To use another OpenAI-compatible provider, set LLM_API_KEY + LLM_BASE_URL + LLM_MODEL.
const LLM_KEY = process.env.ZHIPU_API_KEY || process.env.LLM_API_KEY || '';
const LLM_URL = process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'glm-4-flash';

// Strip an article page down to readable body text for the model.
function extractArticleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

// Generic one-shot chat call to the OpenAI-compatible LLM.
async function llmChat(userText, maxTokens, system) {
  if (!LLM_KEY) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const res = await fetch(LLM_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL, max_tokens: maxTokens || 200, temperature: 0.2,
        messages: [
          { role: 'system', content: system || '你是严谨的中文编辑，严格按要求输出。' },
          { role: 'user', content: userText }
        ]
      })
    });
    clearTimeout(timer);
    const data = await res.json();
    return (data && data.choices && data.choices[0] && data.choices[0].message)
      ? (data.choices[0].message.content || '').trim() : '';
  } catch { return ''; }
}

// Ask the LLM for one accurate Chinese sentence summarizing the article.
async function aiSummarize(title, text) {
  if (!LLM_KEY || !text) return '';
  const out = await llmChat(
    `请用一句简洁、客观、准确的中文概括这条新闻的核心内容，不超过45字；直接陈述事实，不要评论或夸张，不要以“据悉/本文/这篇/近日”等套话开头。只输出这一句话。\n\n标题：${title}\n正文摘录：${text}`,
    200, '你是中文科技新闻编辑，只输出一句话，不加任何前后缀。');
  return cleanSummary(out);
}

// AI curation: in ONE call, ask the model to drop (1) off-topic items whose core
// subject is not AI / robotics / their related industry, and (2) same-event duplicates.
async function aiCurate(items) {
  if (!LLM_KEY || items.length < 2) return items;
  const list = items.map((it, i) => `${i}. [${it.category}] ${it.title}`).join('\n');
  const out = await llmChat(
    `下面是候选新闻标题（带编号和类别）。请标出需要删除的编号，两类都要删：\n(1) 离题：核心主题与「AI/人工智能/机器人/具身智能及其相关产业」无关的——包括恐袭/犯罪/战争/灾难、与AI无关的政治时政/选举/外交、娱乐/体育/影视/社会八卦、纯股市涨跌行情。注意：与AI或机器人相关的科技、财经、融资、芯片算力、产业动态、相关政策要保留。特别要保留：AI/机器人/自动化在本地生活服务（外卖配送、酒旅、宠物、家政、银发经济、到店与零售、餐饮等）的商业落地新闻。\n(2) 重复：与列表中其他条报道同一事件的（措辞不同也算），每组只保留信息最完整的一条，其余删除。\n只输出一个 JSON 数组，列出所有要删除的编号，例如 [2,5,9]；没有要删的就输出 []。不要输出任何其他文字。\n\n${list}`,
    700, '你是严格的中文科技新闻编辑，只保留与AI和机器人相关的新闻，只输出 JSON 数组。');
  try {
    const m = out.match(/\[[\d,\s]*\]/);
    if (!m) return items;
    const drop = new Set(JSON.parse(m[0]).filter(n => Number.isInteger(n) && n >= 0 && n < items.length));
    if (!drop.size) return items;
    if (drop.size > items.length * 0.6) { console.log(`aiCurate drop too large (${drop.size}), ignoring`); return items; }
    console.log(`aiCurate removed ${drop.size} (off-topic + duplicates)`);
    return items.filter((_, i) => !drop.has(i));
  } catch { return items; }
}

function normTitle(t) {
  return (t || '').toLowerCase().replace(/[^一-龥a-z0-9]/g, '').slice(0, 24);
}

// Build a shingle set (English tokens + CJK bigrams) for fuzzy title similarity.
function shingleSet(title) {
  const set = new Set();
  (String(title).toLowerCase().match(/[a-z0-9]{2,}/g) || []).forEach(w => set.add(w));
  const cjk = (String(title).match(/[\u4e00-\u9fa5]/g) || []).join('');
  for (let i = 0; i < cjk.length - 1; i++) set.add(cjk.slice(i, i + 2));
  return set;
}
function shingleOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
function deduplicate(items) {
  const seen = [];
  return items.filter(item => {
    const prefix = normTitle(item.title);
    const sig = shingleSet(item.title);
    for (const prev of seen) {
      if (prefix && prev.prefix === prefix) return false;
      // Near-identical titles (paraphrases differing by a few chars) -> duplicate.
      if (shingleOverlap(sig, prev.sig) >= 0.6) return false;
    }
    seen.push({ prefix, sig });
    return true;
  });
}

const LOCAL_LIFE = /外卖|即时配送|即时零售|本地生活|到店|到家|酒旅|酒店|文旅|旅游|宠物|家政|养老|银发|无人零售|智慧门店|门店|餐饮|送餐|骑手|配送|商用机器人|服务机器人|清洁机器人|巡检机器人|商用落地|规模化落地|落地|部署/;
const BUSINESS_SIGNAL = /发布|推出|上线|首发|量产|落地|融资|收购|并购|合作|签约|中标|订单|营收|财报|政策|规划|战略|突破|新品|发布会|开源|商用|入股|投资|估值|IPO|专利|标准|技术|模型|芯片|算力|机器人|自动驾驶|涨价|降价|扩产|产能|发布会/;
function scoreItem(item) {
  let score = 0;
  const title = item.title.toLowerCase();
  const kw = keywords[item.category] || keywords.ai;
  for (const k of [...(kw.zh || []), ...(kw.en || [])]) if (title.includes(k.toLowerCase())) score += 1;
  const topSources = ['36氪', '机器之心', '量子位', '智东西', '界面', '第一财经', '财联社', '钛媒体', 'IT之家', '晚点',
    'TechCrunch', 'MIT Technology Review', 'The Verge', 'Reuters', 'Bloomberg', 'IEEE Spectrum', 'The Robot Report', 'VentureBeat', 'Ars Technica', 'Wired'];
  if (topSources.some(s => item.source.includes(s))) score += 2;
  if (item.summary) score += 1;
  if (item.lang === 'zh') score += 1;
  // Boost formal, business/product/trend-relevant headlines (发布/融资/量产/政策/突破...).
  if (BUSINESS_SIGNAL.test(item.title)) score += 2;
  if (LOCAL_LIFE.test(item.title)) score += 2;  // favor commercial / local-life deployment
  return score;
}

async function main() {
  console.log(`[${new Date().toLocaleString()}] Starting news fetch...`);
  const globalTimer = setTimeout(() => {
    console.error('GLOBAL TIMEOUT: Exceeded 7 minutes. Force exiting with success.');
    process.exit(0);
  }, GLOBAL_TIMEOUT);

  const outlets = flattenOutlets();
  console.log(`Fetching ${outlets.length} outlets (native RSS + Google News in parallel)...`);
  const newsResults = await withTimeout(
    asyncPool(CONCURRENT_LIMIT, outlets, fetchOutlet),
    150 * 1000, 'All outlet fetches'
  ) || [];

  let allItems = [];
  for (const result of (Array.isArray(newsResults) ? newsResults : [])) {
    if (result && result.status === 'fulfilled' && Array.isArray(result.value)) allItems.push(...result.value);
    else if (Array.isArray(result)) allItems.push(...result);
  }
  console.log(`Total raw items: ${allItems.length}`);

  allItems = deduplicate(allItems);
  console.log(`After same-day dedup: ${allItems.length}`);

  const outputDir = path.join(__dirname, 'output');
  const historyPath = path.join(outputDir, 'history.json');
  const seenLinks = new Set();
  const seenTitles = new Set();
  let history = {};
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      const cut = new Date(); cut.setDate(cut.getDate() - 14);
      const cutStr = cut.toISOString().split('T')[0];
      const todayStr = getEditionDate();
      for (const [date, rec] of Object.entries(history)) {
        // Exclude today's own earlier runs: multiple daily cron runs must NOT dedup
        // against each other (that would shrink the edition every run). Only avoid
        // repeating content from PREVIOUS days.
        if (date < cutStr || date === todayStr) continue;
        const links = Array.isArray(rec) ? rec : (rec.links || []);
        const titles = Array.isArray(rec) ? [] : (rec.titles || []);
        links.forEach(l => seenLinks.add(l));
        titles.forEach(t => seenTitles.add(t));
      }
    } catch (e) { console.log('History read error, continuing'); }
  }
  const before = allItems.length;
  allItems = allItems.filter(it => !seenLinks.has(it.link) && !seenTitles.has(normTitle(it.title)));
  console.log(`After cross-day dedup: ${allItems.length} (removed ${before - allItems.length})`);

  allItems.sort((a, b) => scoreItem(b) - scoreItem(a));

  // AI curation on top candidates: drop off-topic items + same-event duplicates.
  if (LLM_KEY) {
    const head = await aiCurate(allItems.slice(0, 60));
    allItems = head.concat(allItems.slice(60));
  }

  // Per-category sizing: AI and robotics each 6-12; application optional up to 6.
  // Chinese >= 70% overall: Chinese-first only to the floor, English to the floor,
  // then top up (Chinese freely; English only while zh ratio stays >= 70%).
  const CAT_MIN = { ai: 6, robotics: 6, application: 0 };
  const CAT_MAX = { ai: 12, robotics: 12, application: 8 };
  const catCount = { ai: 0, robotics: 0, application: 0 };
  const selected = [];
  const inSel = new Set();
  const srcCount = {};
  const zhCountNow = () => selected.reduce((n, s) => n + (s.lang === 'zh' ? 1 : 0), 0);
  const tryAdd = (it, srcCap) => {
    if (!it || inSel.has(it)) return false;
    const c = it.category;
    if (catCount[c] >= CAT_MAX[c]) return false;
    if ((srcCount[it.source] || 0) >= srcCap) return false;
    selected.push(it); inSel.add(it);
    srcCount[it.source] = (srcCount[it.source] || 0) + 1; catCount[c]++;
    return true;
  };
  for (const cat of ['robotics', 'ai', 'application']) {
    for (const it of allItems.filter(i => i.category === cat && i.lang === 'zh')) {
      if (catCount[cat] >= CAT_MIN[cat]) break;
      tryAdd(it, SOURCE_CAP);
    }
  }
  for (const cat of ['robotics', 'ai']) {
    for (const it of allItems.filter(i => i.category === cat && i.lang === 'en')) {
      if (catCount[cat] >= CAT_MIN[cat]) break;
      tryAdd(it, SOURCE_CAP);
    }
  }
  for (const it of allItems) {
    if (inSel.has(it)) continue;
    if (it.lang === 'en') {
      const ratioAfter = zhCountNow() / (selected.length + 1);
      if (ratioAfter < ZH_RATIO) continue;
    }
    tryAdd(it, SOURCE_CAP);
  }
  for (const cat of ['robotics', 'ai']) {
    if (catCount[cat] >= CAT_MIN[cat]) continue;
    for (const it of [...allItems.filter(i => i.category === cat && i.lang === 'zh'),
                      ...allItems.filter(i => i.category === cat && i.lang === 'en')]) {
      if (catCount[cat] >= CAT_MIN[cat]) break;
      tryAdd(it, Infinity);
    }
  }

  selected.sort((a, b) => scoreItem(b) - scoreItem(a));
  const heroIdx = selected.findIndex(i => i.lang === 'zh');
  if (heroIdx > 0) { const [h] = selected.splice(heroIdx, 1); selected.unshift(h); }

  // Give every item a whole-article one-liner: resolve link -> meta description.
  console.log('Enriching summaries...');
  await asyncPool(8, selected, enrichSummary);

  // Translate English titles + summaries to Chinese (concurrent).
  console.log('Translating English items...');
  await asyncPool(6, selected.filter(item => item.lang === 'en'), async (item) => {
    const needSum = !LLM_KEY && item.summary; // AI summaries are already Chinese
    const [zhTitle, zhSum] = await Promise.all([
      translateToZh(item.title),
      needSum ? translateToZh(item.summary) : Promise.resolve(null)
    ]);
    if (zhTitle) item.titleZh = zhTitle;
    if (zhSum) item.summaryZh = cleanSummary(zhSum);
  });

  // Drop any summary that repeats across items (a sign of site-boilerplate, not article text).
  const sumCount = {};
  for (const it of selected) { const k = it.summaryZh || it.summary; if (k) sumCount[k] = (sumCount[k] || 0) + 1; }
  for (const it of selected) { const k = it.summaryZh || it.summary; if (k && sumCount[k] > 1) { it.summary = ''; it.summaryZh = ''; } }

  const counts = selected.reduce((a, i) => (a[i.category] = (a[i.category] || 0) + 1, a), {});
  const zhCount = selected.filter(s => s.lang === 'zh').length;
  console.log(`Selected ${selected.length}: AI=${counts.ai || 0} Robotics=${counts.robotics || 0} App=${counts.application || 0} | 中文=${zhCount} 英文=${selected.length - zhCount}`);

  const today = getEditionDate();
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(path.join(outputDir, `${today}.html`), generateHTML(selected, today), 'utf8');
  fs.writeFileSync(path.join(outputDir, `${today}.json`),
    JSON.stringify({ date: today, generatedAt: new Date().toISOString(), items: selected }, null, 2), 'utf8');

  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest = [];
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.includes(today)) { manifest.push(today); manifest.sort(); }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  history[today] = { links: selected.map(i => i.link), titles: selected.map(i => normTitle(i.title)) };
  const cut = new Date(); cut.setDate(cut.getDate() - 14);
  const cutStr = cut.toISOString().split('T')[0];
  for (const date of Object.keys(history)) if (date < cutStr) delete history[date];
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');

  console.log(`\nDone! Output: ${path.join(outputDir, today + '.html')}`);
  clearTimeout(globalTimer);
}

main().catch(console.error);
