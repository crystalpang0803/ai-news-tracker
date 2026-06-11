const categoryLabels = {
  ai: { name: 'AI 人工智能', icon: '🤖', color: '#6366f1' },
  robotics: { name: '机器人', icon: '🦾', color: '#ec4899' },
  application: { name: '商业应用', icon: '🏪', color: '#10b981' }
};

function generateHTML(items, date) {
  // Calculate prev/next dates
  const d = new Date(date);
  const prev = new Date(d); prev.setDate(prev.getDate() - 1);
  const next = new Date(d); next.setDate(next.getDate() + 1);
  const prevDate = prev.toISOString().split('T')[0];
  const nextDate = next.toISOString().split('T')[0];

  const grouped = { ai: [], robotics: [], application: [] };
  for (const item of items) {
    if (grouped[item.category]) {
      grouped[item.category].push(item);
    }
  }

  const sections = Object.entries(grouped)
    .filter(([_, items]) => items.length > 0)
    .map(([cat, items]) => {
      const label = categoryLabels[cat];
      const newsItems = items.map(item => {
        const titleDisplay = item.titleZh 
          ? `${escapeHtml(item.titleZh)}<br><span class="en-title">${escapeHtml(item.title)}</span>`
          : escapeHtml(item.title);
        return `
        <div class="news-item">
          <a href="${item.link}" target="_blank" rel="noopener">${titleDisplay}</a>
          <span class="source">${escapeHtml(item.source)}</span>
        </div>
      `;
      }).join('');

      return `
        <section class="category" style="border-left-color: ${label.color}">
          <h2>${label.icon} ${label.name}</h2>
          ${newsItems}
        </section>
      `;
    }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI & 机器人行业日报 - ${date}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #334155;
    }
    header h1 {
      font-size: 1.8rem;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    header .date {
      color: #94a3b8;
      font-size: 0.9rem;
    }
    .category {
      margin-bottom: 2rem;
      padding-left: 1rem;
      border-left: 3px solid;
    }
    .category h2 {
      font-size: 1.2rem;
      margin-bottom: 0.8rem;
      color: #f1f5f9;
    }
    .news-item {
      margin-bottom: 0.8rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid #1e293b;
    }
    .news-item:last-child { border-bottom: none; }
    .news-item a {
      color: #e2e8f0;
      text-decoration: none;
      font-size: 0.95rem;
      line-height: 1.5;
      display: block;
    }
    .news-item a:hover {
      color: #818cf8;
    }
    .en-title {
      font-size: 0.8rem;
      color: #64748b;
      font-style: italic;
    }
    .source {
      display: inline-block;
      margin-top: 0.3rem;
      font-size: 0.75rem;
      color: #64748b;
      background: #1e293b;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
    }
    footer {
      text-align: center;
      color: #475569;
      font-size: 0.8rem;
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #334155;
    }
    .nav {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .nav a, .nav button {
      background: #1e293b;
      color: #818cf8;
      border: 1px solid #334155;
      padding: 0.4rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .nav a:hover, .nav button:hover { background: #334155; }
    .nav input[type="date"] {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.85rem;
    }
    @media (max-width: 600px) {
      body { padding: 1rem; }
      header h1 { font-size: 1.4rem; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI & 机器人行业日报</h1>
    <p class="date">${date} | 共 ${items.length} 条精选</p>
  </header>
  <div class="nav">
    <a href="${prevDate}.html">← 前一天</a>
    <input type="date" value="${date}" onchange="window.location.href=this.value+'.html'">
    <a href="${nextDate}.html">后一天 →</a>
  </div>
  ${sections}
  <footer>
    <p>数据来源：60+ 中英文科技媒体 | 自动生成于 ${new Date().toLocaleTimeString('zh-CN')}</p>
  </footer>
</body>
</html>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

module.exports = { generateHTML };