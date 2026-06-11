const categoryLabels = {
  ai: { name: 'AI 人工智能', icon: '🤖', color: '#0ea5e9' },
  robotics: { name: '机器人', icon: '🦾', color: '#6366f1' },
  application: { name: '商业应用', icon: '🏪', color: '#059669' }
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
        let titleDisplay;
        if (item.titleZh) {
          // English as main title, Chinese translation below
          titleDisplay = `<span class="main-title">${escapeHtml(item.title)}</span><br><span class="zh-title">${escapeHtml(item.titleZh)}</span>`;
        } else {
          titleDisplay = `<span class="main-title">${escapeHtml(item.title)}</span>`;
        }
        return `
        <div class="news-item">
          <a href="${item.link}" target="_blank" rel="noopener">${titleDisplay}</a>
          <span class="source">${escapeHtml(item.source)}</span>
        </div>
      `;
      }).join('');

      return `
        <section class="category">
          <div class="category-header" style="border-color: ${label.color}">
            <span class="category-icon">${label.icon}</span>
            <h2>${label.name}</h2>
          </div>
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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: #f8fafc;
      color: #1e293b;
      padding: 2.5rem 1.5rem;
      max-width: 860px;
      margin: 0 auto;
      line-height: 1.6;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 2px solid #e2e8f0;
    }
    header h1 {
      font-size: 2rem;
      font-weight: 700;
      color: #0369a1;
      margin-bottom: 0.4rem;
      letter-spacing: -0.5px;
    }
    header .date {
      color: #64748b;
      font-size: 0.9rem;
    }
    .nav {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0.8rem;
      margin-bottom: 2rem;
    }
    .nav a {
      background: #ffffff;
      color: #0369a1;
      border: 1px solid #bae6fd;
      padding: 0.5rem 1.2rem;
      border-radius: 8px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all 0.2s;
    }
    .nav a:hover { background: #e0f2fe; border-color: #0ea5e9; }
    .nav input[type="date"] {
      background: #ffffff;
      color: #1e293b;
      border: 1px solid #cbd5e1;
      padding: 0.5rem 0.8rem;
      border-radius: 8px;
      font-size: 0.85rem;
    }
    .category {
      margin-bottom: 2rem;
      background: #ffffff;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      padding-bottom: 0.8rem;
      border-bottom: 2px solid;
    }
    .category-icon { font-size: 1.3rem; }
    .category h2 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #334155;
    }
    .news-item {
      padding: 0.8rem 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .news-item:last-child { border-bottom: none; }
    .news-item a {
      color: #1e293b;
      text-decoration: none;
      display: block;
      transition: color 0.2s;
    }
    .news-item a:hover { color: #0369a1; }
    .main-title {
      font-size: 0.95rem;
      font-weight: 500;
      line-height: 1.5;
    }
    .zh-title {
      font-size: 0.85rem;
      color: #64748b;
      line-height: 1.5;
      margin-top: 2px;
      display: inline-block;
    }
    .source {
      display: inline-block;
      margin-top: 0.4rem;
      font-size: 0.7rem;
      color: #94a3b8;
      background: #f1f5f9;
      padding: 0.2rem 0.6rem;
      border-radius: 4px;
      font-weight: 500;
    }
    footer {
      text-align: center;
      color: #94a3b8;
      font-size: 0.8rem;
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid #e2e8f0;
    }
    @media (max-width: 600px) {
      body { padding: 1.5rem 1rem; }
      header h1 { font-size: 1.5rem; }
      .category { padding: 1rem; }
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
