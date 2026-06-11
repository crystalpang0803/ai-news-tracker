const newsData = [
  {
    id: 1,
    title: "工信部：持续推进人工智能赋能新型工业化",
    date: "2026-06-08",
    category: "AI",
    source: "工信部",
    summary: "围绕大模型、行业数据和算力基础设施，继续推动 AI 在制造场景落地。",
    url: "https://www.miit.gov.cn/"
  },
  {
    id: 2,
    title: "新华社科技频道聚焦人形机器人产业进展",
    date: "2026-06-09",
    category: "机器人",
    source: "新华社",
    summary: "报道显示人形机器人在物流、巡检、服务等场景的商业化节奏正在加快。",
    url: "https://www.news.cn/tech/"
  },
  {
    id: 3,
    title: "中国新闻网 IT 频道持续更新大模型与应用新闻",
    date: "2026-06-10",
    category: "AI",
    source: "中国新闻网",
    summary: "覆盖模型发布、企业落地与政策动向，便于追踪国内 AI 最新进展。",
    url: "https://www.chinanews.com.cn/it/"
  },
  {
    id: 4,
    title: "人民网科技频道关注协作机器人与智能制造",
    date: "2026-06-10",
    category: "机器人",
    source: "人民网",
    summary: "聚焦工业机器人、协作机器人及智能工厂相关政策和产业动态。",
    url: "http://it.people.com.cn/"
  }
];

const dateFilterEl = document.getElementById("dateFilter");
const clearFilterEl = document.getElementById("clearFilter");
const resultCountEl = document.getElementById("resultCount");
const newsListEl = document.getElementById("newsList");

function renderNews(items) {
  if (!items.length) {
    newsListEl.innerHTML = '<div class="empty">该日期暂无 AI / 机器人新闻</div>';
    resultCountEl.textContent = "共 0 条";
    return;
  }

  newsListEl.innerHTML = items
    .map(
      (item) => `
      <article class="news-item">
        <div class="news-meta">${item.date} · ${item.category} · ${item.source}</div>
        <h2 class="news-title">${item.title}</h2>
        <p class="news-summary">${item.summary}</p>
        <a class="news-link" href="${item.url}" target="_blank" rel="noopener noreferrer">阅读原文</a>
      </article>
    `
    )
    .join("");

  resultCountEl.textContent = `共 ${items.length} 条`;
}

function getFilteredNews(dateValue) {
  const sorted = [...newsData].sort((a, b) => b.date.localeCompare(a.date));
  if (!dateValue) return sorted;
  return sorted.filter((item) => item.date === dateValue);
}

function handleFilterChange() {
  const selectedDate = dateFilterEl.value;
  const filtered = getFilteredNews(selectedDate);
  renderNews(filtered);
}

dateFilterEl.addEventListener("change", handleFilterChange);
clearFilterEl.addEventListener("click", () => {
  dateFilterEl.value = "";
  handleFilterChange();
});

handleFilterChange();