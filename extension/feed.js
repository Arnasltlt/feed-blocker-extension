document.addEventListener('DOMContentLoaded', () => {
  const escBootstrap = (v) => String(v || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function showBootstrapError(err) {
    const msg = escBootstrap(err?.message || String(err));
    const main = document.querySelector('.feed-content') || document.body;
    main.innerHTML = `
      <div class="empty-state" style="display:block;padding:32px 24px;text-align:center;max-width:520px;margin:0 auto;">
        <h2 style="margin-bottom:12px;">Couldn’t load Focus Feed</h2>
        <p style="color:#64748b;line-height:1.5;">${msg}</p>
        <p style="margin-top:16px;font-size:13px;color:#64748b;">Try reloading this tab. If this persists, reload the extension.</p>
      </div>`;
  }

  const feedContent = document.querySelector('.feed-content');
  // feed-grid removed; items surface through Explore
  const emptyState = document.getElementById('empty-state');
  const clearBtn = document.getElementById('clear-history-btn');
  const loadMockBtn = document.getElementById('load-mock-btn');
  const summarizeBtn = document.getElementById('summarize-btn');
  const modelSelect = document.getElementById('model-select');
  const researchToolSelect = document.getElementById('research-tool-select');
  const summarySection = document.getElementById('summary-section');
  const summaryTopics = document.getElementById('summary-topics');
  const briefHeadline = document.getElementById('brief-headline');
  const briefDeck = document.getElementById('brief-deck');

  if (!feedContent || !clearBtn || !loadMockBtn || !summarizeBtn || !modelSelect || !researchToolSelect
    || !summarySection || !summaryTopics || !briefHeadline || !briefDeck || !emptyState) {
    showBootstrapError(new Error('Focus Feed page is missing required elements.'));
    return;
  }

  const STORAGE_KEY = 'feed_recommendations';
  const SUMMARY_CACHE_KEY = 'feed_summary_brief';
  const SUMMARY_MODEL_KEY = 'feed_summary_model';
  const RESEARCH_TOOL_KEY = 'feed_research_tool';
  const SEEN_TOPICS_KEY = 'feed_seen_topics';
  const SEEN_TOPICS_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
  const SUMMARIZE_API = 'https://feed-blocking-server.fly.dev/summarize';
  const RESEARCH_TOOLS = {
    perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
    grok: (q) => `https://x.com/i/grok?text=${encodeURIComponent(q)}`,
    chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  };
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
  const LOCAL_SUMMARY_RULES = [
    { key: 'ai', label: 'AI and developer tools', keywords: ['ai', 'gpt', 'llm', 'agent', 'agents', 'model', 'models', 'openai', 'claude', 'coding', 'developer', 'devtools'] },
    { key: 'space', label: 'Space and science', keywords: ['nasa', 'space', 'moon', 'rocket', 'artemis', 'science'] },
    { key: 'music', label: 'Music and entertainment', keywords: ['music', 'song', 'album', 'band', 'concert', 'video'] },
    { key: 'politics', label: 'Politics and current events', keywords: ['court', 'judge', 'trump', 'war', 'policy', 'news', 'breaking'] },
    { key: 'business', label: 'Business and startups', keywords: ['business', 'startup', 'founder', 'market', 'company', 'ceo'] },
    { key: 'productivity', label: 'Productivity and workflow', keywords: ['workflow', 'productivity', 'browser', 'atlas', 'setup', 'tools'] },
    { key: 'gaming', label: 'Gaming', keywords: ['game', 'gaming', 'warcraft', 'xbox', 'playstation', 'steam'] }
  ];
  const STOP_WORDS = new Set([
    'about', 'after', 'again', 'all', 'also', 'and', 'are', 'been', 'being', 'between',
    'could', 'from', 'have', 'into', 'just', 'like', 'more', 'most', 'much', 'only',
    'other', 'over', 'really', 'should', 'showing', 'that', 'their', 'them', 'then',
    'there', 'these', 'this', 'those', 'through', 'today', 'under', 'very', 'what',
    'when', 'where', 'which', 'while', 'with', 'would', 'your', 'youtube'
  ]);
  let hasAttemptedAutoSummary = false;

  Promise.all([initializeModelPicker(), initializeResearchToolPicker()])
    .then(() => loadRecommendations())
    .catch((err) => {
      console.error('[feed] bootstrap failed:', err);
      showBootstrapError(err);
    });

  clearBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear your feed history?')) {
      await chrome.storage.local.remove(STORAGE_KEY);
      await chrome.storage.local.remove(SUMMARY_CACHE_KEY);
      loadRecommendations();
      resetSummarySurface();
    }
  });

  loadMockBtn.addEventListener('click', () => {
    generateMockData();
  });

  summarizeBtn.addEventListener('click', async () => {
    await generateSummary();
  });

  modelSelect.addEventListener('change', async () => {
    const selectedModel = getSelectedSummaryModel();
    await chrome.storage.local.set({ [SUMMARY_MODEL_KEY]: selectedModel });
    hasAttemptedAutoSummary = false;
    await loadRecommendations();
  });

  async function initializeModelPicker() {
    const result = await chrome.storage.local.get(SUMMARY_MODEL_KEY);
    const savedModel = normalizeSummaryModel(result[SUMMARY_MODEL_KEY]);
    modelSelect.value = savedModel;
    if (savedModel !== result[SUMMARY_MODEL_KEY]) {
      await chrome.storage.local.set({ [SUMMARY_MODEL_KEY]: savedModel });
    }
  }

  async function initializeResearchToolPicker() {
    const result = await chrome.storage.local.get(RESEARCH_TOOL_KEY);
    const saved = result[RESEARCH_TOOL_KEY];
    if (saved && RESEARCH_TOOLS[saved]) {
      researchToolSelect.value = saved;
    }
    researchToolSelect.addEventListener('change', async () => {
      await chrome.storage.local.set({ [RESEARCH_TOOL_KEY]: researchToolSelect.value });
    });
  }

  function buildResearchQuery(topic, tool) {
    const title = safeText(topic && topic.title, '', '');
    const oneLiner = safeText(topic && topic.one_liner, topic && topic.summary, '');
    const citationQuote = safeText(topic?.citations?.[0]?.quote, '', '');
    const core = oneLiner || title;
    if (!core) return '';

    switch (tool) {
      case 'google':
        return truncateToOneLine(title || oneLiner, 100);

      case 'chatgpt':
        return `I saw this in my feed: "${truncateToOneLine(core, 160)}". What's the full story — who's involved, what happened, and why does it matter?`;

      case 'grok':
        return `What's the latest on this? ${truncateToOneLine(core, 160)}`;

      case 'perplexity':
      default: {
        const suffix = citationQuote && !core.includes(citationQuote.slice(0, 25))
          ? ` (one source says: "${truncateToOneLine(citationQuote, 80)}")`
          : '';
        return `${truncateToOneLine(core, 160)}${suffix} — what happened and why does it matter?`;
      }
    }
  }

  function openResearchTool(topic) {
    const tool = researchToolSelect.value || 'perplexity';
    const urlBuilder = RESEARCH_TOOLS[tool] || RESEARCH_TOOLS.perplexity;
    const query = buildResearchQuery(topic, tool);
    chrome.tabs.create({ url: urlBuilder(query) });
  }

  function topicFingerprint(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  async function loadSeenTopics() {
    const result = await chrome.storage.local.get(SEEN_TOPICS_KEY);
    const entries = result[SEEN_TOPICS_KEY] || [];
    const now = Date.now();
    return entries.filter((e) => e.seenAt && (now - e.seenAt) < SEEN_TOPICS_TTL_MS);
  }

  async function saveSeenTopics(topics) {
    const existing = await loadSeenTopics();
    const newFingerprints = new Set(existing.map((e) => e.fingerprint));
    const now = Date.now();
    const toAdd = topics
      .map((t) => ({ fingerprint: topicFingerprint(t.title), title: t.title, seenAt: now }))
      .filter((e) => e.fingerprint && !newFingerprints.has(e.fingerprint));
    const merged = [...existing, ...toAdd].slice(-30); // keep last 30
    await chrome.storage.local.set({ [SEEN_TOPICS_KEY]: merged });
  }

  async function loadRecommendations() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY] || [];
      if (!data || data.length === 0) {
        emptyState.classList.remove('hidden');
      } else {
        emptyState.classList.add('hidden');
      }
      await restoreOrGenerateSummary(data);
    } catch (err) {
      console.error('Failed to load recommendations:', err);
    }
  }

  async function generateMockData() {
    const now = Date.now();
    const mock = [
      {
        platform: 'youtube',
        timestamp: now,
        count: 3,
        recommendations: [
          { title: 'The Future of AI Agents', url: 'https://youtube.com/watch?v=123', channel: 'Tech Daily' },
          { title: 'Artemis mission explainer', url: 'https://youtube.com/watch?v=456', channel: 'NASA' },
          { title: 'Workflow setup for solo founders', url: 'https://youtube.com/watch?v=789', channel: 'Builder Lab' }
        ]
      },
      {
        platform: 'twitter',
        timestamp: now - 1000 * 60 * 12,
        count: 3,
        recommendations: [
          { title: 'OpenAI shipped another model update', url: 'https://x.com/example/1', author: 'openai' },
          { title: 'Supreme Court reaction thread', url: 'https://x.com/example/2', author: 'newswire' },
          { title: 'Why business software is getting agent layers', url: 'https://x.com/example/3', author: 'founder' }
        ]
      }
    ];

    await chrome.storage.local.set({ [STORAGE_KEY]: mock });
    loadRecommendations();
  }

  async function generateSummary(prefetchedData) {
    let fallbackSummary = null;
    let currentItems = [];

    try {
      const data = Array.isArray(prefetchedData)
        ? prefetchedData
        : (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];

      if (!data || data.length === 0) {
        showSummaryError('No feed data available. Visit some sites first!');
        return;
      }

      currentItems = flattenFeedItems(data);
      if (currentItems.length === 0) {
        showSummaryError('No items found to summarize.');
        return;
      }

      fallbackSummary = buildLocalFallbackSummary(currentItems);

      summarizeBtn.disabled = true;
      summarizeBtn.textContent = 'Building Brief...';
      summaryTopics.innerHTML = '<div class="summary-loading">Building your brief...</div>';
      feedContent.classList.add('has-summary');
      summarySection.classList.remove('hidden');

      const selectedModel = getSelectedSummaryModel();
      const seenEntries = await loadSeenTopics();
      const seenTopicTitles = seenEntries.map((e) => e.title);

      const response = await fetch(SUMMARIZE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items: currentItems, summary_model: selectedModel, seen_topics: seenTopicTitles }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const apiResult = await response.json();

      if (apiResult.nothing_new) {
        await showNothingNew();
        await persistSummaryCache({ nothing_new: true, topics: [], overview: null }, currentItems, selectedModel);
        return;
      }

      const summary = normalizeSummaryResponse(apiResult, currentItems, fallbackSummary);

      if (summary && summary.topics.length > 0) {
        renderSummary(summary);
        await persistSummaryCache(summary, currentItems, selectedModel);
        await saveSeenTopics(summary.topics);
        return;
      }

      showSummaryError('No topics found. Try visiting more sites to build your feed.');
    } catch (err) {
      console.error('Failed to generate summary:', err);

      if (fallbackSummary && fallbackSummary.topics.length > 0) {
        renderSummary(fallbackSummary);
        await persistSummaryCache(fallbackSummary, currentItems, selectedModel);
        return;
      }

      showSummaryError('Failed to generate summary. Check your connection and try again.');
    } finally {
      summarizeBtn.disabled = false;
      summarizeBtn.textContent = 'Summarize My Feed';
    }
  }

  function flattenFeedItems(data) {
    const items = [];
    const seenItems = new Set();

    [...data].reverse().forEach((entry) => {
      const platform = entry.platform || 'unknown';
      const capturedAt = normalizeTimestamp(entry.timestamp);

      if (Array.isArray(entry.recommendations)) {
        entry.recommendations.forEach((rec) => {
          const title = (rec.title || '').trim();
          const author = (rec.author || rec.channel || '').trim();
          const fullText = (rec.fullText || '').trim();
          const context = (rec.context || '').trim();
          const dedupeKey = rec.url || `${platform}::${author}::${title}`.toLowerCase();

          if (!title || seenItems.has(dedupeKey)) {
            return;
          }

          seenItems.add(dedupeKey);
          items.push({
            title,
            platform,
            channel: rec.channel,
            author,
            url: rec.url,
            full_text: fullText,
            context,
            summary_text: [title, fullText, context].filter(Boolean).join('\n'),
            captured_at: capturedAt
          });
        });
      }
    });

    return items;
  }

  function normalizeSummaryResponse(apiResult, items, fallbackSummary) {
    const topics = Array.isArray(apiResult && apiResult.topics) ? apiResult.topics : [];

    if (topics.length === 0) {
      if (fallbackSummary && fallbackSummary.topics.length > 0) {
        return fallbackSummary;
      }
      return null;
    }

    return {
      overview: apiResult.overview || fallbackSummary.overview || buildFallbackOverview(items, topics),
      topics: topics.map((topic, index) => normalizeTopic(topic, fallbackSummary.topics[index])),
      picks: Array.isArray(apiResult.picks) && apiResult.picks.length > 0
        ? apiResult.picks.map(normalizePick)
        : fallbackSummary.picks
    };
  }

  function normalizeTopic(topic, fallbackTopic) {
    return {
      title: safeText(topic && topic.title, fallbackTopic && fallbackTopic.title, 'Untitled topic'),
      // Never pull one_liner from the local fallback — it's boilerplate. Use the LLM's own summary if one_liner is absent.
      one_liner: safeText(topic && topic.one_liner, topic && topic.summary, ''),
      type: safeText(topic && topic.type, fallbackTopic && fallbackTopic.type, 'trend'),
      score: typeof topic?.score === 'number' ? topic.score : fallbackTopic?.score || 0.6,
      badges: normalizeTextList(topic && topic.badges, fallbackTopic && fallbackTopic.badges),
      citations: normalizeCitations(topic && topic.citations, fallbackTopic && fallbackTopic.citations),
      recommended_links: normalizeLinks(topic && topic.recommended_links, fallbackTopic && fallbackTopic.recommended_links),
      signals: normalizeSignals(topic && topic.signals, fallbackTopic && fallbackTopic.signals),
    };
  }

  function normalizePick(pick) {
    return {
      title: safeText(pick && pick.title, '', 'Untitled link'),
      url: safeText(pick && pick.url, '', '#'),
      attribution: safeText(pick && pick.attribution, '', 'Unknown source'),
      platform: safeText(pick && pick.platform, '', 'Feed'),
      reason: safeText(pick && pick.reason, '', 'Strong entry point into a top topic.')
    };
  }

  function normalizeCitations(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback || [];
    return source
      .map((citation) => ({
        quote: safeText(citation && citation.quote, '', ''),
        attribution: safeText(citation && citation.attribution, '', '')
      }))
      .filter((citation) => citation.quote && citation.attribution)
      .slice(0, 3);
  }

  function normalizeLinks(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback || [];
    return source
      .map((link) => ({
        title: safeText(link && link.title, '', 'Untitled link'),
        url: safeText(link && link.url, '', '#'),
        attribution: safeText(link && link.attribution, '', 'Unknown source'),
        platform: safeText(link && link.platform, '', 'Feed')
      }))
      .filter((link) => link.url && link.url !== '#')
      .slice(0, 3);
  }

  function normalizeSignals(primary, fallback) {
    const source = primary && typeof primary === 'object' ? primary : fallback || {};
    const bucketTotal = typeof source.bucket_total === 'number' ? source.bucket_total : 0;
    return {
      item_count: source.item_count || 0,
      bucket_total: bucketTotal > 0 ? bucketTotal : source.item_count || 0,
      platform_count: source.platform_count || 0,
      platforms: Array.isArray(source.platforms) ? source.platforms : [],
      freshness: safeText(source.freshness, '', 'recent'),
      depth: safeText(source.depth, '', 'medium')
    };
  }

  function renderSummary(summary) {
    feedContent.classList.add('has-summary');
    renderOverview(summary.overview, summary.topics);
    renderTopics(summary.topics);
    summarySection.classList.remove('hidden');
  }

  async function restoreOrGenerateSummary(data) {
    const items = flattenFeedItems(data);
    if (items.length === 0) {
      resetSummarySurface();
      return;
    }

    const cached = await chrome.storage.local.get(SUMMARY_CACHE_KEY);
    const cachedSummary = cached[SUMMARY_CACHE_KEY];
    const selectedModel = getSelectedSummaryModel();
    const signature = createItemSignature(items, selectedModel);

    if (cachedSummary && cachedSummary.signature === signature && cachedSummary.summary) {
      const cachedTopics = cachedSummary.summary.topics || [];
      const hasOneLiner = cachedTopics.length === 0 || cachedTopics.some((t) => t.one_liner && t.one_liner.trim());
      if (!hasOneLiner) {
        // Cache is stale (pre-one_liner schema) — drop it and re-generate
        await chrome.storage.local.remove(SUMMARY_CACHE_KEY);
      } else if (cachedSummary.summary.nothing_new) {
        await showNothingNew();
        return;
      } else {
        renderSummary(cachedSummary.summary);
        return;
      }
    }

    if (!hasAttemptedAutoSummary) {
      hasAttemptedAutoSummary = true;
      await generateSummary(data);
    }
  }

  function renderOverview(overview, topics) {
    briefHeadline.textContent = safeText(overview && overview.headline, '', 'Your feed, distilled.');
    const deck = overview && overview.deck;
    if (deck) {
      briefDeck.textContent = deck;
    } else if (Array.isArray(topics) && topics.length > 0) {
      const allPlatforms = Array.from(new Set(
        topics.flatMap((t) => (t.signals && Array.isArray(t.signals.platforms) ? t.signals.platforms : []))
      ));
      const platformStr = allPlatforms.length > 0 ? allPlatforms.join(', ') : 'your feeds';
      briefDeck.textContent = `${topics.length} topic${topics.length !== 1 ? 's' : ''} across ${platformStr}.`;
    } else {
      briefDeck.textContent = 'The strongest recurring themes, why they matter, and what to click first.';
    }
  }

  function truncateToOneLine(text, maxLen) {
    const t = String(text || '').trim();
    if (!t) {
      return '';
    }
    if (t.length <= maxLen) {
      return t;
    }
    const cut = t.slice(0, maxLen);
    const lastPeriod = cut.lastIndexOf('.');
    if (lastPeriod > 40) {
      return cut.slice(0, lastPeriod + 1).trim();
    }
    return cut.replace(/\s+\S*$/, '') + '…';
  }

  function topicHeadline(topic) {
    const line = safeText(topic.one_liner, '', '');
    if (line) {
      return line;
    }
    return truncateToOneLine(topic.summary, 200) || safeText(topic.title, '', 'Untitled topic');
  }

  function renderTopics(topics) {
    summaryTopics.innerHTML = '';

    topics.forEach((topic, index) => {
      const row = document.createElement('article');
      row.className = 'summary-topic-row';

      const signals = topic.signals || {};
      const freshness = capitalize(safeText(signals.freshness, '', 'recent'));
      const platforms = Array.isArray(signals.platforms) ? signals.platforms : [];
      const platformStr = platforms.length ? platforms.join(' · ') : '';
      const shown = signals.item_count || 0;
      const total = typeof signals.bucket_total === 'number' && signals.bucket_total > 0
        ? signals.bucket_total
        : shown;
      const metaParts = [freshness];
      if (platformStr) {
        metaParts.push(platformStr);
      }
      if (shown && total > shown) {
        metaParts.push(`${shown} highlighted · ${total} in this bucket`);
      } else if (shown) {
        metaParts.push(`${shown} items`);
      }
      const metaLine = metaParts.join(' · ');

      const titleText = safeText(topic.title, '', '');
      row.innerHTML = `
        <div class="summary-topic-row__body">
          ${titleText ? `<p class="topic-label">${escapeHtml(titleText)}</p>` : ''}
          <p class="topic-one-liner">${escapeHtml(topicHeadline(topic))}</p>
          <p class="topic-row-meta">${escapeHtml(metaLine)}</p>
        </div>
        <button type="button" class="topic-explore-btn" data-topic-index="${index}">Explore →</button>
      `;

      const exploreBtn = row.querySelector('.topic-explore-btn');
      exploreBtn.addEventListener('click', () => openResearchTool(topic));

      summaryTopics.appendChild(row);
    });
  }

  function buildLocalFallbackSummary(items) {
    const grouped = new Map();

    items.forEach((item) => {
      const key = findLocalTopicKey(item.title);
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(item);
    });

    const topics = Array.from(grouped.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 4)
      .map(([key, groupedItems]) => buildLocalTopic(key, groupedItems))
      .filter(Boolean);

    return {
      overview: buildFallbackOverview(items, topics),
      topics,
      picks: buildFallbackPicks(topics)
    };
  }

  function buildLocalOneLiner(label, keywords, sampleItems = []) {
    const primary = safeText(sampleItems[0]?.title, '', '');
    const secondary = safeText(sampleItems[1]?.title, '', '');
    const termText = keywords.slice(0, 2).join(' and ') || label.toLowerCase();

    if (primary && secondary) {
      return truncateToOneLine(`${primary}. This cluster keeps circling ${termText}, with "${trimTitleForLine(secondary, 72)}" reinforcing it.`, 240);
    }
    if (primary) {
      return truncateToOneLine(`${primary}. It keeps resurfacing around ${termText} in your saved items.`, 240);
    }
    return truncateToOneLine(`${label} keeps resurfacing in your saved items, especially around ${termText}.`, 240);
  }

  function buildLocalTopic(key, groupedItems) {
    if (!groupedItems || groupedItems.length === 0) {
      return null;
    }

    const sample = groupedItems.slice(0, 6);
    const keywords = extractKeywords(groupedItems);
    const platforms = Array.from(new Set(groupedItems.map((item) => capitalize(item.platform || 'unknown'))));
    const topicType = inferLocalTopicType(groupedItems);
    const freshness = inferLocalFreshness(groupedItems);
    const depth = inferLocalDepth(groupedItems);
    const label = buildLocalTopicLabel(key, keywords);
    const bucketTotal = groupedItems.length;
    const oneLiner =
      bucketTotal === 1 && String(sample[0].title || '').trim()
        ? String(sample[0].title || '').trim().slice(0, 240)
        : buildLocalOneLiner(label, keywords, sample);

    return {
      title: label,
      one_liner: oneLiner,
      type: topicType,
      score: Math.min(0.96, 0.48 + groupedItems.length * 0.08 + (platforms.length > 1 ? 0.12 : 0)),
      why_showing_up: `${groupedItems.length} saved items across ${platforms.join(', ')} keep repeating ${keywords.slice(0, 3).join(', ') || 'similar language'}.`,
      summary: `This local fallback brief is clustering around ${keywords.slice(0, 3).join(', ') || 'recurring feed themes'}. It is a good candidate for attention because the signal is repeating instead of appearing as a single stray item.`,
      takeaways: [
        `Primary thread: ${keywords.slice(0, 3).join(', ') || label.toLowerCase()}.`,
        `Most of the signal is coming from ${platforms.join(', ')}.`,
        'Open one strong explainer first, then sample a second source for contrast.'
      ],
      tension: topicType === 'debate'
        ? 'This cluster contains disagreement or friction, so the value comes from comparing takes rather than accepting one summary.'
        : 'The discussion is mostly additive, which makes this good for fast context gathering.',
      why_it_matters: `Your saved feed is repeatedly pointing at ${keywords.slice(0, 2).join(' and ') || 'this theme'}, so it is likely more relevant than a one-off recommendation.`,
      badges: [
        platforms.length > 1 ? 'Cross-platform' : null,
        freshness === 'today' || freshness === 'fresh' ? 'New' : null,
        depth === 'high' ? 'Deep dive' : null,
        topicType === 'debate' ? 'Debate' : null
      ].filter(Boolean),
      citations: sample.slice(0, 3).map((item) => ({
        quote: item.title,
        attribution: item.channel || item.author || capitalize(item.platform || 'feed')
      })),
      recommended_links: sample
        .filter((item) => item.url)
        .slice(0, 3)
        .map((item) => ({
          title: item.title,
          url: item.url,
          attribution: item.channel || item.author || capitalize(item.platform || 'feed'),
          platform: capitalize(item.platform || 'feed')
        })),
      signals: {
        item_count: sample.length,
        bucket_total: bucketTotal,
        platform_count: platforms.length,
        platforms,
        freshness,
        depth
      }
    };
  }

  function buildFallbackOverview(items, topics) {
    const platforms = Array.from(new Set(items.map((item) => capitalize(item.platform || 'unknown'))));
    const leadTopic = topics[0];
    const leadHeadline = leadTopic
      ? (isGenericTopicTitle(leadTopic.title)
        ? safeText(leadTopic.one_liner, '', 'Your feed is ready to summarize.')
        : `${leadTopic.title} is leading your feed right now.`)
      : 'Your feed is ready to summarize.';
    return {
      headline: leadHeadline,
      deck: `${topics.length} strong themes surfaced across ${platforms.join(', ')}. This brief highlights the clearest repeated patterns and the fastest links to open next.`,
      stats: [
        { label: 'Saved items', value: String(items.length) },
        { label: 'Platforms', value: String(platforms.length) },
        { label: 'Top topics', value: String(topics.length) }
      ]
    };
  }

  function buildFallbackPicks(topics) {
    const picks = [];
    const seenUrls = new Set();

    topics.forEach((topic) => {
      topic.recommended_links.forEach((link) => {
        if (!link.url || seenUrls.has(link.url) || picks.length >= 6) {
          return;
        }
        seenUrls.add(link.url);
        picks.push({
          title: link.title,
          url: link.url,
          attribution: link.attribution,
          platform: link.platform,
          reason: `Strong entry point into ${topic.title}.`
        });
      });
    });

    return picks;
  }

  async function persistSummaryCache(summary, items, model) {
    if (!summary || summary.nothing_new) {
      await chrome.storage.local.set({
        [SUMMARY_CACHE_KEY]: {
          signature: createItemSignature(items, model),
          summary
        }
      });
      return;
    }
    if (!Array.isArray(summary.topics) || summary.topics.length === 0) {
      return;
    }

    await chrome.storage.local.set({
      [SUMMARY_CACHE_KEY]: {
        signature: createItemSignature(items, model),
        summary
      }
    });

    // Persist the headline so "nothing new" state can reference it
    const headline = summary.overview && summary.overview.headline;
    if (headline) {
      await chrome.storage.local.set({
        feed_last_brief_meta: { headline, timestamp: Date.now() }
      });
    }
  }

  function createItemSignature(items, model) {
    return items
      .map((item) => `${item.platform || ''}:${item.title || ''}:${item.url || ''}`)
      .sort()
      .join('|') + `::${normalizeSummaryModel(model)}`;
  }

  function getSelectedSummaryModel() {
    return normalizeSummaryModel(modelSelect.value);
  }

  function normalizeSummaryModel(value) {
    return SUMMARY_MODELS.includes(value) ? value : SUMMARY_MODELS[0];
  }

  function findLocalTopicKey(title) {
    const normalized = normalizeText(title);

    for (const rule of LOCAL_SUMMARY_RULES) {
      if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
        return rule.key;
      }
    }

    const keywords = extractKeywords([{ title }]);
    return keywords[0] || 'general';
  }

  function buildLocalTopicLabel(key, keywords) {
    const matchedRule = LOCAL_SUMMARY_RULES.find((rule) => rule.key === key);
    if (matchedRule) {
      return matchedRule.label;
    }
    if (keywords.length > 0) {
      return `Watching ${capitalize(keywords[0])}`;
    }
    return 'Notable feed chatter';
  }

  function extractKeywords(items) {
    const counts = new Map();

    items.forEach((item) => {
      normalizeText(item.summary_text || item.full_text || item.title)
        .split(' ')
        .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
        .forEach((word) => {
          counts.set(word, (counts.get(word) || 0) + 1);
        });
    });

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  function inferLocalTopicType(items) {
    const combined = items.map((item) => (item.summary_text || item.full_text || item.title || '').toLowerCase()).join(' ');
    const platforms = new Set(items.map((item) => item.platform).filter(Boolean));

    if (/(debate|vs|argument|fight|reaction)/.test(combined)) {
      return 'debate';
    }
    if (/(launch|release|new|unveils|adds|ship)/.test(combined)) {
      return 'breakthrough';
    }
    if (/(tutorial|walkthrough|guide|setup|explainer|breakdown)/.test(combined)) {
      return 'deep_dive';
    }
    if (items.length >= 3 || platforms.size >= 2) {
      return 'trend';
    }
    return 'niche';
  }

  function inferLocalFreshness(items) {
    const timestamps = items
      .map((item) => item.captured_at)
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()));

    if (timestamps.length === 0) {
      return 'recent';
    }

    const newest = Math.max(...timestamps.map((value) => value.getTime()));
    const ageHours = (Date.now() - newest) / (1000 * 60 * 60);

    if (ageHours <= 6) {
      return 'today';
    }
    if (ageHours <= 30) {
      return 'fresh';
    }
    if (ageHours <= 72) {
      return 'recent';
    }
    return 'older';
  }

  function inferLocalDepth(items) {
    const combined = items.map((item) => (item.summary_text || item.full_text || item.title || '').toLowerCase()).join(' ');
    if (/(tutorial|walkthrough|guide|setup|explainer|breakdown|course)/.test(combined)) {
      return 'high';
    }
    if (/(analysis|interview|strategy|discussion)/.test(combined)) {
      return 'medium';
    }
    return 'light';
  }

  function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
    if (typeof value === 'string' && value) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    return '';
  }

  function formatTopicType(type) {
    return safeText(type, '', 'trend')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString();
      }
    } catch (error) {
      return '#';
    }
    return '#';
  }

  function safeText(value, fallback, finalFallback) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof fallback === 'string' && fallback.trim()) {
      return fallback.trim();
    }
    return finalFallback;
  }

  function normalizeTextList(primary, fallback) {
    const source = Array.isArray(primary) && primary.length > 0 ? primary : fallback || [];
    return source
      .map((item) => safeText(item, '', ''))
      .filter(Boolean)
      .slice(0, 3);
  }

  function normalizeText(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }

  function isGenericTopicTitle(title) {
    const normalized = normalizeText(title);
    return !normalized
      || GENERIC_TOPIC_TITLES.has(normalized)
      || normalized.startsWith('watching ');
  }

  function trimTitleForLine(text, maxLen) {
    const value = safeText(text, '', '');
    if (!value) {
      return '';
    }
    const shortened = truncateToOneLine(value, maxLen);
    return shortened.replace(/[.?!…]+$/, '').trim();
  }


  async function showNothingNew() {
    feedContent.classList.add('has-summary');
    briefHeadline.textContent = 'All quiet.';
    let deck = 'Nothing new since your last check.';
    try {
      const result = await chrome.storage.local.get('feed_last_brief_meta');
      const meta = result['feed_last_brief_meta'];
      if (meta && meta.headline && meta.timestamp) {
        const ageMs = Date.now() - meta.timestamp;
        const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
        const ageLabel = ageHours < 1 ? 'less than an hour ago'
          : ageHours === 1 ? '1 hour ago'
          : ageHours < 24 ? `${ageHours} hours ago`
          : 'yesterday';
        deck = `Nothing new since "${meta.headline}" — ${ageLabel}.`;
      }
    } catch (_) { /* storage unavailable */ }
    briefDeck.textContent = deck;
    summaryTopics.innerHTML = '';
    summarySection.classList.remove('hidden');
  }

  function showSummaryError(message) {
    feedContent.classList.add('has-summary');
    briefHeadline.textContent = 'Your feed, distilled.';
    briefDeck.textContent = 'The strongest recurring themes, why they matter, and what to click first.';
    summaryTopics.innerHTML = `<div class="summary-error">${escapeHtml(message)}</div>`;
    summarySection.classList.remove('hidden');
  }

  function resetSummarySurface() {
    summaryTopics.innerHTML = '';
    briefHeadline.textContent = 'Your feed, distilled.';
    briefDeck.textContent = 'The strongest recurring themes, why they matter, and what to click first.';
    feedContent.classList.remove('has-summary');
    summarySection.classList.add('hidden');
  }
});
