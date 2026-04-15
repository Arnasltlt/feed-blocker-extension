const CACHE_KEY = 'feed_summary_brief';
const TOOL_KEY = 'feed_research_tool';
const RESEARCH_TOOLS = {
  perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  grok: (q) => `https://x.com/i/grok?text=${encodeURIComponent(q)}`,
  chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
};
const GENERIC_TOPIC_TITLES = new Set([
  'ai and developer tools',
  'space and science',
  'music and entertainment',
  'politics and current events',
  'business and startups',
  'productivity and workflow',
  'gaming',
  'notable feed chatter',
  'general'
]);

const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtAge = (ts) => {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return 'yesterday';
};

const normalizeText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const truncateLine = (text, maxLen) => {
  const value = String(text || '').trim();
  if (!value || value.length <= maxLen) return value;
  const cut = value.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf('.');
  if (lastPeriod > 40) return cut.slice(0, lastPeriod + 1).trim();
  return cut.replace(/\s+\S*$/, '') + '…';
};

const isGenericTopicTitle = (title) => {
  const normalized = normalizeText(title);
  return !normalized || GENERIC_TOPIC_TITLES.has(normalized) || normalized.startsWith('watching ');
};

const buildTopicQuery = (topic, tool) => {
  const title = String(topic?.title || '').trim();
  const oneLiner = String(topic?.one_liner || topic?.summary || '').trim();
  const citationQuote = String(topic?.citations?.[0]?.quote || '').trim();
  const core = oneLiner || title;
  if (!core) return '';

  switch (tool) {
    case 'google':
      return truncateLine(title || oneLiner, 100);

    case 'chatgpt':
      return `I saw this in my feed: "${truncateLine(core, 160)}". What's the full story — who's involved, what happened, and why does it matter?`;

    case 'grok':
      return `What's the latest on this? ${truncateLine(core, 160)}`;

    case 'perplexity':
    default: {
      const suffix = citationQuote && !core.includes(citationQuote.slice(0, 25))
        ? ` (one source says: "${truncateLine(citationQuote, 80)}")`
        : '';
      return `${truncateLine(core, 160)}${suffix} — what happened and why does it matter?`;
    }
  }
};

document.getElementById('open-full').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') });
});

async function load() {
  const stored = await chrome.storage.local.get([CACHE_KEY, TOOL_KEY, 'feed_last_brief_meta']);
  const cached = stored[CACHE_KEY];
  const tool = stored[TOOL_KEY] || 'perplexity';
  const meta = stored['feed_last_brief_meta'] || null;
  const content = document.getElementById('content');

  if (!cached || !cached.summary) {
    content.innerHTML = `
      <div class="empty-block">
        <div class="empty-icon">🌱</div>
        <p class="empty-title">No brief yet</p>
        <p class="empty-sub">Browse X or LinkedIn, then open the full feed to generate your first brief.</p>
      </div>
    `;
    return;
  }

  const { summary } = cached;

  if (summary.nothing_new) {
    const since = (meta && meta.headline) ? `"${esc(meta.headline)}"` : 'your last brief';
    const age = meta && meta.timestamp ? fmtAge(meta.timestamp) : '';
    content.innerHTML = `
      <div class="brief-eyebrow">Talk of the Town</div>
      <div class="quiet-block">
        <p class="quiet-title">All quiet.</p>
        <p class="quiet-since">Nothing new since ${since}${age ? ` — ${age}` : ''}.</p>
        <p class="quiet-permission">You're up to date.</p>
      </div>
      <div class="popup-footer">
        <span class="popup-footer-label">${age ? `Updated ${esc(age)}` : 'Recent'}</span>
        <button class="popup-footer-link" id="open-full-2">Full feed ↗</button>
      </div>
    `;
    document.getElementById('open-full-2').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') });
    });
    return;
  }

  const topics = summary.topics || [];
  if (!topics.length) {
    content.innerHTML = `<div class="empty-block"><p class="empty-title">No topics found</p><p class="empty-sub">Open the full feed to generate a new brief.</p></div>`;
    return;
  }

  const headline = (summary.overview && summary.overview.headline) || 'Your feed, distilled.';
  const age = meta && meta.timestamp ? fmtAge(meta.timestamp) : '';

  const topicsHtml = topics.map((topic, i) => `
    <div class="topic-row">
      <div class="topic-row-body">
        ${topic.title ? `<p class="topic-row-label">${esc(topic.title)}</p>` : ''}
        <p class="topic-row-liner">${esc(topic.one_liner || topic.title || '')}</p>
      </div>
      <button class="topic-explore" data-idx="${i}">Explore →</button>
    </div>
  `).join('');

  content.innerHTML = `
    <div class="brief-eyebrow">Talk of the Town</div>
    <div class="brief-headline">${esc(headline)}</div>
    ${topicsHtml}
    <div class="popup-footer">
      <span class="popup-footer-label">${age ? `Updated ${esc(age)}` : 'Recent'}</span>
      <button class="popup-footer-link" id="open-full-2">Full feed ↗</button>
    </div>
  `;

  document.getElementById('open-full-2').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') });
  });

  document.querySelectorAll('.topic-explore').forEach((btn) => {
    const idx = parseInt(btn.dataset.idx, 10);
    btn.addEventListener('click', () => {
      const t = topics[idx];
      const builder = RESEARCH_TOOLS[tool] || RESEARCH_TOOLS.perplexity;
      chrome.tabs.create({ url: builder(buildTopicQuery(t, tool)) });
    });
  });
}

load();
