(() => {
  const X_HOSTNAMES = new Set(['x.com', 'twitter.com']);
  const HOME_PATHS = new Set(['/', '/home', '/i/home', '/explore']);
  const FEED_SELECTORS = [
    'div[data-testid="primaryColumn"] section',
    'div[data-testid="primaryColumn"] div[aria-label="Timeline: Your Home Timeline"]',
    'main [aria-label="Timeline: Your Home Timeline"]',
    'main div[data-testid="column"] section',
    'div[data-testid="primaryColumn"] nav',
  ];
  const ASIDE_SELECTORS = [
    '[data-testid="sidebarColumn"]',
    '[aria-label="Timeline: Trending now"]',
    '[aria-label="Timeline: Explore"]'
  ];
  const CHECK_DELAY_MS = 120;
  const SUMMARIZE_API = 'https://feed-blocking-server.fly.dev/summarize';
  const STORAGE_KEY = 'feed_recommendations';
  const SUMMARY_CACHE_KEY = 'feed_summary_brief';
  const SEEN_TOPICS_KEY = 'feed_seen_topics';
  const RESEARCH_TOOL_KEY = 'feed_research_tool';
  const SUMMARY_MODEL_KEY = 'feed_summary_model';
  const SUMMARY_MODELS = [
    'google/gemini-3.1-flash-lite-preview',
    'google/gemini-3-flash-preview'
  ];
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
  const SEEN_TOPICS_TTL_MS = 48 * 60 * 60 * 1000;
  const RESEARCH_TOOLS = {
    perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
    grok: (q) => `https://x.com/i/grok?text=${encodeURIComponent(q)}`,
    chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  };

  let scheduledCheckId = null;
  let mutationObserver;
  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();
  let isRefreshing = false;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const isHomePage = () => {
    if (!X_HOSTNAMES.has(window.location.hostname)) return false;
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return HOME_PATHS.has(path) || path.startsWith('/home');
  };

  const escHtml = (v) => String(v || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const normalizeText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const truncateLine = (text, maxLen) => {
    const value = String(text || '').trim();
    if (!value || value.length <= maxLen) return value;
    const cut = value.slice(0, maxLen);
    const lastPeriod = cut.lastIndexOf('.');
    if (lastPeriod > 40) return cut.slice(0, lastPeriod + 1).trim();
    return cut.replace(/\s+\S*$/, '') + '...';
  };

  const isGenericTopicTitle = (title) => {
    const normalized = normalizeText(title);
    return !normalized || GENERIC_TOPIC_TITLES.has(normalized) || normalized.startsWith('watching ');
  };

  const buildTopicQuery = (topic, tool) => {
    const title = String(topic?.title || '').trim();
    const oneLiner = String(topic?.one_liner || '').trim();
    const citationQuote = String(topic?.citations?.[0]?.quote || '').trim();
    const core = oneLiner || title;
    if (!core) return '';

    switch (tool) {
      case 'google':
        // Keyword search: title is the anchor, no instruction words
        return truncateLine(title || oneLiner, 100);

      case 'chatgpt':
        return `I saw this in my feed: "${truncateLine(core, 160)}". What's the full story — who's involved, what happened, and why does it matter?`;

      case 'grok':
        return `What's the latest on this? ${truncateLine(core, 160)}`;

      case 'perplexity':
      default: {
        // Perplexity handles natural questions well and surfaces sources automatically
        const suffix = citationQuote && !core.includes(citationQuote.slice(0, 25))
          ? ` (one source says: "${truncateLine(citationQuote, 80)}")`
          : '';
        return `${truncateLine(core, 160)}${suffix} — what happened and why does it matter?`;
      }
    }
  };

  const normalizeSummaryModel = (value) => SUMMARY_MODELS.includes(value) ? value : SUMMARY_MODELS[0];

  // ─── Feed hiding ───────────────────────────────────────────────────────────

  const hideElement = (el) => {
    if (!previousDisplay.has(el)) previousDisplay.set(el, el.style.getPropertyValue('display'));
    el.style.setProperty('display', 'none', 'important');
    hiddenElements.add(el);
  };

  const restoreElement = (el) => {
    const prior = previousDisplay.get(el);
    if (typeof prior === 'string' && prior.length > 0) el.style.setProperty('display', prior);
    else el.style.removeProperty('display');
    previousDisplay.delete(el);
    hiddenElements.delete(el);
  };

  const revealHidden = () => Array.from(hiddenElements).forEach(restoreElement);

  const hideFeedElements = () => {
    const nodes = new Set();
    FEED_SELECTORS.forEach((sel) => document.querySelectorAll(sel).forEach((n) => { if (n instanceof HTMLElement) nodes.add(n); }));
    ASIDE_SELECTORS.forEach((sel) => document.querySelectorAll(sel).forEach((n) => { if (n instanceof HTMLElement) nodes.add(n); }));
    nodes.forEach(hideElement);
  };

  const flattenStoredItems = (data) => {
    const seen = new Set();
    const items = [];
    [...data].reverse().forEach((entry) => {
      (entry.recommendations || []).forEach((rec) => {
        const key = rec.url || `${entry.platform}::${rec.author || rec.channel}::${rec.title}`.toLowerCase();
        if (!rec.title || seen.has(key)) return;
        seen.add(key);
        items.push({
          title: rec.title,
          platform: entry.platform,
          channel: rec.channel,
          author: rec.author,
          url: rec.url,
          full_text: rec.fullText || '',
          context: rec.context || '',
          summary_text: [rec.title, rec.fullText, rec.context].filter(Boolean).join('\n'),
          captured_at: new Date(entry.timestamp || Date.now()).toISOString(),
        });
      });
    });
    return items;
  };

  const createItemSignature = (items, model) => items
    .map((item) => `${item.platform || ''}:${item.title || ''}:${item.url || ''}`)
    .sort()
    .join('|') + `::${normalizeSummaryModel(model)}`;

  // ─── Tweet extraction ──────────────────────────────────────────────────────

  const extractTweets = () => {
    if (!isHomePage()) return [];
    const tweets = [];
    const seen = new Set();
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      try {
        const text = (article.querySelector('[data-testid="tweetText"]') || {}).textContent?.trim() || '';
        const authorEl = article.querySelector('[data-testid="User-Name"] a[role="link"]') || article.querySelector('[data-testid="User-Name"] span');
        const author = authorEl ? authorEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const contextEl = article.querySelector('[data-testid="socialContext"]') || article.querySelector('div[dir="ltr"] span');
        const context = contextEl ? contextEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const timeEl = article.querySelector('time');
        const url = timeEl?.closest('a')?.href || '';
        if (!text || !url || seen.has(url)) return;
        seen.add(url);
        const likeEl = article.querySelector('[data-testid="like"]');
        const retweetEl = article.querySelector('[data-testid="retweet"]');
        const replyEl = article.querySelector('[data-testid="reply"]');
        tweets.push({
          title: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
          fullText: text, author, context, url,
          likeCount: (likeEl?.getAttribute('aria-label') || likeEl?.textContent || '').trim(),
          retweetCount: (retweetEl?.getAttribute('aria-label') || retweetEl?.textContent || '').trim(),
          replyCount: (replyEl?.getAttribute('aria-label') || replyEl?.textContent || '').trim(),
          position: tweets.length,
        });
      } catch (e) { /* skip */ }
    });
    if (tweets.length > 0 && window.RecommendationTracker) {
      window.RecommendationTracker.capture('twitter', tweets).catch(() => {});
    }
    return tweets;
  };

  // ─── Styles ────────────────────────────────────────────────────────────────

  const injectStyles = () => {
    if (document.getElementById('ff-styles')) return;
    const style = document.createElement('style');
    style.id = 'ff-styles';
    style.textContent = `
      #ff-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        border-bottom: 1px solid #2f3336;
      }
      .ff-header {
        padding: 16px 16px 14px;
        border-bottom: 1px solid #2f3336;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .ff-header-copy { flex: 1; min-width: 0; }
      .ff-eyebrow {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #f4a81d;
        margin: 0 0 5px;
      }
      .ff-headline {
        font-size: 20px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: -0.03em;
        color: #e7e9ea;
        margin: 0 0 4px;
      }
      .ff-deck {
        font-size: 13px;
        color: #536471;
        margin: 0;
      }
      .ff-refresh-btn {
        flex-shrink: 0;
        padding: 6px 14px;
        border-radius: 9999px;
        background: transparent;
        border: 1px solid #2f3336;
        color: #536471;
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        margin-top: 2px;
        transition: border-color 0.15s, color 0.15s;
      }
      .ff-refresh-btn:hover:not(:disabled) { border-color: #536471; color: #e7e9ea; }
      .ff-refresh-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .ff-topic {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid #2f3336;
        transition: background 0.12s;
        cursor: default;
      }
      .ff-topic:hover { background: rgba(255,255,255,0.03); }
      .ff-topic-body { flex: 1; min-width: 0; }
      .ff-topic-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: #f4a81d;
        margin: 0 0 4px;
      }
      .ff-topic-liner {
        font-size: 15px;
        font-weight: 400;
        line-height: 1.5;
        color: #e7e9ea;
        margin: 0 0 5px;
      }
      .ff-topic-meta { font-size: 12px; color: #536471; margin: 0; }
      .ff-explore-btn {
        flex-shrink: 0;
        margin-top: 2px;
        padding: 7px 14px;
        border-radius: 9999px;
        background: transparent;
        border: 1px solid #2f3336;
        color: #1d9bf0;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.12s, border-color 0.12s;
      }
      .ff-explore-btn:hover { background: rgba(29,155,240,0.1); border-color: rgba(29,155,240,0.4); }
      .ff-footer {
        padding: 12px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid #2f3336;
      }
      .ff-footer-label { font-size: 12px; color: #536471; }
      .ff-open-full {
        font-size: 13px;
        color: #1d9bf0;
        background: none;
        border: none;
        cursor: pointer;
        font-family: inherit;
        font-weight: 500;
        padding: 0;
      }
      .ff-open-full:hover { text-decoration: underline; }
      .ff-state {
        padding: 48px 24px;
        text-align: center;
        border-bottom: 1px solid #2f3336;
      }
      .ff-state-title { font-size: 17px; font-weight: 600; color: #e7e9ea; margin: 0 0 6px; }
      .ff-state-sub { font-size: 14px; color: #536471; max-width: 300px; margin: 0 auto; line-height: 1.5; }
      .ff-quiet {
        padding: 40px 24px;
        text-align: center;
        border-bottom: 1px solid #2f3336;
        background: rgba(244,168,29,0.04);
      }
      .ff-quiet-title { font-size: 22px; font-weight: 700; color: #e7e9ea; margin: 0 0 8px; letter-spacing: -0.02em; }
      .ff-quiet-since { font-size: 14px; color: #71767b; margin: 0 0 4px; line-height: 1.5; }
      .ff-quiet-permission { font-size: 13px; color: #536471; margin: 0; font-style: italic; }
      .ff-spinner {
        width: 20px; height: 20px;
        border: 2px solid #2f3336;
        border-top-color: #1d9bf0;
        border-radius: 50%;
        animation: ff-spin 0.8s linear infinite;
        margin: 0 auto 12px;
      }
      @keyframes ff-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  };

  // ─── Container injection ───────────────────────────────────────────────────

  const getOrCreateContainer = () => {
    const existing = document.getElementById('ff-container');
    if (existing) return existing;

    const primaryCol = document.querySelector('div[data-testid="primaryColumn"]');
    if (!primaryCol) return null;

    const container = document.createElement('div');
    container.id = 'ff-container';

    // Insert after first child (the sticky header area), or at top
    const firstChild = primaryCol.firstElementChild;
    if (firstChild && firstChild.nextSibling) {
      primaryCol.insertBefore(container, firstChild.nextSibling);
    } else if (firstChild) {
      primaryCol.appendChild(container);
    } else {
      primaryCol.prepend(container);
    }

    return container;
  };

  // ─── Render functions ──────────────────────────────────────────────────────

  const renderLoading = (container) => {
    container.innerHTML = `
      <div class="ff-state">
        <div class="ff-spinner"></div>
        <p class="ff-state-title">Building your brief…</p>
        <p class="ff-state-sub">Pulling signal from your last few days of browsing.</p>
      </div>
    `;
  };

  const renderNoData = (container) => {
    container.innerHTML = `
      <div class="ff-state">
        <p class="ff-state-title">No feed data yet</p>
        <p class="ff-state-sub">Browse X for a bit to collect signal, then your brief will appear here.</p>
      </div>
    `;
  };

  const formatAge = (timestamp) => {
    if (!timestamp) return '';
    const ageMs = Date.now() - timestamp;
    const ageMin = Math.floor(ageMs / 60000);
    if (ageMin < 2) return 'just now';
    if (ageMin < 60) return `${ageMin}m ago`;
    const ageHours = Math.floor(ageMin / 60);
    if (ageHours < 24) return `${ageHours}h ago`;
    return 'yesterday';
  };

  const renderNothingNew = (container, meta, researchTool) => {
    const since = (meta && meta.headline) ? `"${escHtml(meta.headline)}"` : 'your last brief';
    const ageLabel = meta && meta.timestamp ? formatAge(meta.timestamp) : '';
    container.innerHTML = `
      <div class="ff-header" style="border-bottom:none;padding-bottom:0;">
        <div class="ff-header-copy">
          <p class="ff-eyebrow">Talk of the Town</p>
        </div>
        <button class="ff-refresh-btn" id="ff-refresh">Refresh</button>
      </div>
      <div class="ff-quiet">
        <p class="ff-quiet-title">All quiet.</p>
        <p class="ff-quiet-since">Nothing new since ${since}${ageLabel ? ` — ${ageLabel}` : ''}.</p>
        <p class="ff-quiet-permission">You're up to date. Good time to close this tab.</p>
      </div>
      <div class="ff-footer">
        <span class="ff-footer-label">Your feed is collected as you browse</span>
        <button class="ff-open-full" id="ff-open-full">Open full feed ↗</button>
      </div>
    `;
    container.querySelector('#ff-refresh').addEventListener('click', () => handleRefresh(container, researchTool));
    container.querySelector('#ff-open-full').addEventListener('click', handleOpenFull);
  };

  const renderBrief = (container, summary, researchTool, generatedAt) => {
    const topics = summary.topics || [];
    const overview = summary.overview || {};
    const headline = overview.headline || 'Your feed, distilled.';

    const allPlatforms = [...new Set(topics.flatMap((t) => (t.signals?.platforms || [])))];
    const deck = topics.length > 0
      ? `${topics.length} topic${topics.length !== 1 ? 's' : ''} · ${allPlatforms.join(', ') || 'your feeds'}`
      : '';

    const topicsHtml = topics.map((topic, i) => {
      const signals = topic.signals || {};
      const platforms = Array.isArray(signals.platforms) ? signals.platforms : [];
      const freshness = cap(signals.freshness || 'Recent');
      const count = signals.item_count || 0;
      const metaParts = [freshness];
      if (platforms.length) metaParts.push(platforms.join(' · '));
      if (count) metaParts.push(`${count} item${count !== 1 ? 's' : ''}`);

      return `
        <div class="ff-topic" data-topic-index="${i}">
          <div class="ff-topic-body">
            ${topic.title ? `<p class="ff-topic-label">${escHtml(topic.title)}</p>` : ''}
            <p class="ff-topic-liner">${escHtml(topic.one_liner || topic.title || '')}</p>
            <p class="ff-topic-meta">${escHtml(metaParts.join(' · '))}</p>
          </div>
          <button class="ff-explore-btn" data-topic-index="${i}">Explore →</button>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="ff-header">
        <div class="ff-header-copy">
          <p class="ff-eyebrow">Talk of the Town</p>
          <h2 class="ff-headline">${escHtml(headline)}</h2>
          ${deck ? `<p class="ff-deck">${escHtml(deck)}</p>` : ''}
        </div>
        <button class="ff-refresh-btn" id="ff-refresh">Refresh</button>
      </div>
      ${topicsHtml}
      <div class="ff-footer">
        <span class="ff-footer-label">${generatedAt ? `Updated ${escHtml(formatAge(generatedAt))}` : 'Collected from your recent browsing'}</span>
        <button class="ff-open-full" id="ff-open-full">Open full feed ↗</button>
      </div>
    `;

    container.querySelector('#ff-refresh').addEventListener('click', () => handleRefresh(container, researchTool));
    container.querySelector('#ff-open-full').addEventListener('click', handleOpenFull);
    container.querySelectorAll('.ff-explore-btn').forEach((btn) => {
      const idx = parseInt(btn.dataset.topicIndex, 10);
      btn.addEventListener('click', () => handleExplore(topics[idx], researchTool));
    });
  };

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleExplore = (topic, researchTool) => {
    const tool = researchTool || 'perplexity';
    const builder = RESEARCH_TOOLS[tool] || RESEARCH_TOOLS.perplexity;
    const query = buildTopicQuery(topic, tool);
    window.open(builder(query), '_blank');
  };

  const handleOpenFull = () => {
    const url = chrome.runtime.getURL('feed.html');
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_FEED_PAGE', url }, () => {
        if (chrome.runtime.lastError) {
          window.open(url, '_blank');
        }
      });
    } catch (e) {
      window.open(url, '_blank');
    }
  };

  const handleRefresh = async (container, researchTool) => {
    if (isRefreshing) return;
    isRefreshing = true;

    const refreshBtn = container.querySelector('#ff-refresh');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = 'Refreshing…'; }

    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, SEEN_TOPICS_KEY, SUMMARY_MODEL_KEY]);
      const data = stored[STORAGE_KEY] || [];

      if (!data.length) {
        renderNoData(container);
        return;
      }

      const items = flattenStoredItems(data);
      if (!items.length) {
        renderNoData(container);
        return;
      }

      // Seen topics dedup
      const seenEntries = (stored[SEEN_TOPICS_KEY] || []).filter((e) => e.seenAt && (Date.now() - e.seenAt) < SEEN_TOPICS_TTL_MS);
      const seenTopicTitles = seenEntries.map((e) => e.title);
      const model = normalizeSummaryModel(stored[SUMMARY_MODEL_KEY]);
      const signature = createItemSignature(items, model);

      const response = await fetch(SUMMARIZE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, summary_model: model, seen_topics: seenTopicTitles }),
      });

      if (!response.ok) throw new Error(`Server ${response.status}`);
      const result = await response.json();

      if (result.nothing_new) {
        await chrome.storage.local.set({ [SUMMARY_CACHE_KEY]: { signature, summary: result } });
        const metaResult = await chrome.storage.local.get('feed_last_brief_meta');
        renderNothingNew(container, metaResult['feed_last_brief_meta'], researchTool);
        return;
      }

      if (result.topics && result.topics.length > 0) {
        // Persist to cache so feed.html stays in sync
        await chrome.storage.local.set({ [SUMMARY_CACHE_KEY]: { signature, summary: result } });
        if (result.overview?.headline) {
          await chrome.storage.local.set({ feed_last_brief_meta: { headline: result.overview.headline, timestamp: Date.now() } });
        }
        renderBrief(container, result, researchTool);
      } else {
        renderNoData(container);
      }
    } catch (err) {
      console.error('[ff] refresh failed:', err);
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = 'Refresh'; }
    } finally {
      isRefreshing = false;
    }
  };

  // ─── Load and render ───────────────────────────────────────────────────────

  const loadAndRender = async (container) => {
    renderLoading(container);

    const stored = await chrome.storage.local.get([SUMMARY_CACHE_KEY, STORAGE_KEY, RESEARCH_TOOL_KEY, SUMMARY_MODEL_KEY, 'feed_last_brief_meta']);
    const researchTool = stored[RESEARCH_TOOL_KEY] || 'perplexity';
    const cached = stored[SUMMARY_CACHE_KEY];
    const meta = stored['feed_last_brief_meta'] || null;
    const generatedAt = meta && meta.timestamp ? meta.timestamp : null;
    const data = stored[STORAGE_KEY] || [];
    const items = flattenStoredItems(data);
    const signature = createItemSignature(items, stored[SUMMARY_MODEL_KEY]);

    if (cached && cached.summary && cached.signature === signature) {
      if (cached.summary.nothing_new) {
        renderNothingNew(container, meta, researchTool);
      } else if (cached.summary.topics && cached.summary.topics.length > 0) {
        renderBrief(container, cached.summary, researchTool, generatedAt);
      } else {
        renderNoData(container);
      }
      return;
    }

    // No cache — auto-summarize if we have data
    if (data.length > 0) {
      await handleRefresh(container, researchTool);
    } else {
      renderNoData(container);
    }
  };

  // ─── Main feed check ───────────────────────────────────────────────────────

  const hideFeeds = () => {
    if (!isHomePage()) {
      revealHidden();
      const existing = document.getElementById('ff-container');
      if (existing) existing.remove();
      return;
    }

    extractTweets();
    hideFeedElements();
    injectStyles();

    const container = getOrCreateContainer();
    if (container && !container.dataset.loaded) {
      container.dataset.loaded = '1';
      loadAndRender(container);
    }
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) return;
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      hideFeeds();
    }, CHECK_DELAY_MS);
  };

  const interceptHistory = () => {
    const wrap = (fn) => function (...args) {
      const result = fn.apply(this, args);
      scheduleCheck();
      return result;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
  };

  const initObservers = () => {
    if (mutationObserver || !document.body) return;
    mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') { scheduleCheck(); break; }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  };

  const init = () => {
    hideFeeds();
    initObservers();
    interceptHistory();
    window.addEventListener('popstate', scheduleCheck, { passive: true });

    // Re-render when a new brief is generated (e.g. from the feed page)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SUMMARY_CACHE_KEY] && isHomePage()) {
        const container = document.getElementById('ff-container');
        if (container) {
          delete container.dataset.loaded;
          loadAndRender(container);
        }
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
