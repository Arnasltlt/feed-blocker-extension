(() => {
  const LINKEDIN_HOSTNAMES = new Set(['www.linkedin.com', 'linkedin.com']);
  const FEED_PATH_PREFIX = '/feed';
  const FEED_SELECTORS = [
    'div.feed-outlet',
    'main.scaffold-layout__main',
    'div.scaffold-layout__main',
    'main[data-id="ember-view"]',
    '[data-id="main-feed"]',
    'div.feed.identity-feed',
    'div.scaffold-layout__list',
    'div.scaffold-layout__list-container',
    'section.feed-container',
    'main > div > div.scaffold-layout__list-container'
  ];
  const NOTIFICATION_SELECTORS = [
    'a[data-test-global-nav-link="notifications"]',
    'button[data-test-global-nav-link="notifications"]',
    '#notifications-tab-icon',
    'a[href*="/notifications/"]',
    'button[aria-label*="Notification"]',
    'a[aria-label*="Notifications"]'
  ];
  const NOTIFICATION_STYLE_ID = 'feed-blocker-linkedin-notifications';
  const NOTIFICATION_STYLE = `
    li.global-nav__primary-item:has(a[data-test-global-nav-link="notifications"]),
    li.global-nav__primary-item:has(button[data-test-global-nav-link="notifications"]),
    div.global-nav__primary-item:has(a[data-test-global-nav-link="notifications"]),
    div.global-nav__primary-item:has(button[data-test-global-nav-link="notifications"]),
    a[data-test-global-nav-link="notifications"],
    button[data-test-global-nav-link="notifications"],
    #notifications-tab-icon,
    a[href*="/notifications/"],
    button[aria-label*="Notification"],
    a[aria-label*="Notifications"] {
      display: none !important;
      visibility: hidden !important;
    }
  `;
  
  const findFeedByContent = () => {
    const mainElements = document.querySelectorAll('main');
    for (const main of mainElements) {
      const hasFeedContent = main.querySelector('article, div[data-id*="feed"], div[class*="feed"], button[name*="New post"], div[class*="update-components"]');
      if (hasFeedContent && main.offsetHeight > 300) {
        const feedContainer = main.querySelector('div.scaffold-layout__list-container, div[class*="scaffold-layout__list"], div[class*="feed"]');
        if (feedContainer) {
          return feedContainer;
        }
        return main;
      }
    }
    const scaffoldMains = document.querySelectorAll('div.scaffold-layout__main, main.scaffold-layout__main');
    for (const candidate of scaffoldMains) {
      const hasFeedContent = candidate.querySelector('article, button[name*="New post"], div[class*="update-components"]');
      if (hasFeedContent && candidate.offsetHeight > 200) {
        return candidate;
      }
    }
    return null;
  };
  const CHECK_DELAY_MS = 150;
  const EXTRACTION_RETRY_MS = 1200;
  const MAX_PRE_HIDE_ATTEMPTS = 4;
  const DEBUG_STORAGE_KEY = 'linkedin_feed_debug';
  const POST_LINK_SELECTORS = [
    'a[href*="/posts/"]',
    'a[href*="/feed/update/"]',
    'a[href*="/activity-"]',
    'a[href*="/pulse/"]',
    'a[href*="ugcPost"]',
    'a[href*="/recent-activity/"]',
    'a[href*="urn:li:activity:"]',
    'a[href*="urn%3Ali%3Aactivity"]'
  ].join(',');
  const POST_CONTAINER_SELECTORS = [
    'div.occludable-update',
    'div.feed-shared-update-v2',
    'article',
    'div[data-id*="urn:li:activity"]',
    'div[data-urn*="activity"]',
    'div[data-view-name*="feed"]',
    'div[data-view-name*="update"]',
    'div.feed-follows-module',
    'div.scaffold-finite-scroll__content > div'
  ].join(',');
  const AUTHOR_SELECTORS = [
    '.update-components-actor__title',
    '.update-components-actor__name',
    '.feed-shared-actor__name',
    'a[href*="/in/"] span[aria-hidden="true"]',
    '.update-components-actor__meta-link span[aria-hidden="true"]'
  ].join(',');
  const CONTEXT_SELECTORS = [
    '.update-components-actor__description',
    '.feed-shared-actor__description',
    '.update-components-actor__sub-description',
    '.update-components-actor__supplementary-actor-info'
  ].join(',');
  const PRIMARY_TEXT_SELECTORS = [
    '.feed-shared-update-v2__description',
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
    '.update-components-text-view',
    '.break-words',
    '[data-test-id="main-feed-activity-card__commentary"]'
  ].join(',');
  const SECONDARY_TEXT_SELECTORS = [
    '.update-components-article__title',
    '.feed-shared-article__title',
    '.update-components-linkedin-article__title',
    '.update-components-text-entity-lockup__title',
    '.update-components-text-entity-lockup__subtitle',
    'a[href*="/posts/"] span[dir="ltr"]',
    'a[href*="/feed/update/"] span[dir="ltr"]'
  ].join(',');
  const ACTION_SELECTORS = [
    'button[aria-label*="Like"]',
    'button[aria-label*="Comment"]',
    'button[aria-label*="Repost"]',
    'button[aria-label*="Send"]',
    '[role="button"][aria-label*="Like"]',
    '[role="button"][aria-label*="Comment"]',
    '[role="button"][aria-label*="Repost"]',
    '[role="button"][aria-label*="Send"]'
  ].join(',');

  let scheduledCheckId = null;
  let extractionRetryId = null;
  let extractionAttempts = 0;
  let storageDebounceId = null;
  let injectMountRetryId = null;
  let mutationObserver;
  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();

  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const simpleHash32 = (str) => {
    let h = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(16);
  };
  const makeSyntheticPostUrl = (author, title, bodyFingerprint) => {
    const origin = window.location.origin || 'https://www.linkedin.com';
    return `${origin}/feed#ff-li-${simpleHash32(`${author}|${title}|${bodyFingerprint}`)}`;
  };
  const GENERIC_POST_LINES = new Set([
    'like',
    'comment',
    'repost',
    'send',
    'share',
    'follow',
    'more',
    'promoted',
    'ad',
    'open to work'
  ]);
  const NOISE_FRAGMENTS = [
    'add to your feed',
    'view all recommendations',
    'grow your business faster',
    'try premium page',
    'advertise on linkedin',
    'my pages',
    'profile viewers',
    'post impressions',
    'promoted',
    'activity0',
    'feed post',
    'suggested for you'
  ];
  /** Short promo / sidebar cards only — avoid rejecting full feed posts that mention these phrases */
  const CARD_PROMO_MAX_CHARS = 400;
  const CARD_PROMO_ONLY_FRAGMENTS = [
    'add to your feed',
    'view all recommendations',
    'grow your business faster',
    'try premium page',
    'advertise on linkedin',
    'my pages'
  ];

  const addUniqueText = (items, value) => {
    const text = normalizeText(value);
    if (!text || items.includes(text)) {
      return;
    }
    items.push(text);
  };

  const gatherTexts = (root, selector) => {
    if (!root) {
      return [];
    }
    const texts = [];
    root.querySelectorAll(selector).forEach((element) => {
      addUniqueText(texts, element.textContent);
    });
    return texts;
  };

  const firstNonEmptyText = (root, selector) => {
    const values = gatherTexts(root, selector);
    return values.find(Boolean) || '';
  };

  const summarizeTextLines = (value) => {
    return String(value || '')
      .split('\n')
      .map((line) => normalizeText(line))
      .filter((line) => {
        if (!line || line.length < 8) {
          return false;
        }
        const lower = line.toLowerCase();
        if (NOISE_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
          return false;
        }
        return !GENERIC_POST_LINES.has(lower);
      });
  };

  const shouldSkipContainer = (element) => {
    if (!(element instanceof HTMLElement)) {
      return true;
    }
    if (element.closest('aside, nav, header, footer')) {
      return true;
    }
    const text = normalizeText(element.innerText).toLowerCase();
    if (!text) {
      return true;
    }
    const len = text.length;
    if (len < CARD_PROMO_MAX_CHARS && CARD_PROMO_ONLY_FRAGMENTS.some((fragment) => text.includes(fragment))) {
      return true;
    }
    if (len < 220 && text.includes('promoted') && !element.querySelector(POST_LINK_SELECTORS)) {
      return true;
    }
    if (len < 260 && text.includes('suggested for you')) {
      return true;
    }
    return false;
  };

  const findFallbackAuthor = (postElement) => {
    const authorLink = postElement.querySelector(
      'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]'
    );
    if (authorLink) {
      return normalizeText(authorLink.textContent);
    }
    const lines = summarizeTextLines(postElement.innerText);
    return lines[0] || '';
  };

  const buildTextCandidates = (postElement, author, context) => {
    const texts = [];
    gatherTexts(postElement, PRIMARY_TEXT_SELECTORS).forEach((text) => addUniqueText(texts, text));
    gatherTexts(postElement, SECONDARY_TEXT_SELECTORS).forEach((text) => addUniqueText(texts, text));

    summarizeTextLines(postElement.innerText)
      .filter((line) => line !== author && line !== context)
      .slice(0, 8)
      .forEach((line) => addUniqueText(texts, line));

    return texts;
  };

  const buildDebugSnapshot = async (snapshot) => {
    if (!chrome?.storage?.local) {
      return;
    }
    try {
      await chrome.storage.local.set({
        [DEBUG_STORAGE_KEY]: {
          ...snapshot,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.debug('[linkedin-feed-blocker] Failed to persist debug snapshot:', error);
    }
  };

  const reportScriptError = (phase, error) => {
    const message = error instanceof Error ? error.message : String(error || '');
    const stack = error instanceof Error ? String(error.stack || '').slice(0, 600) : '';
    void buildDebugSnapshot({
      phase,
      status: 'error',
      url: window.location.href,
      message,
      stack
    });
  };

  const looksLikeFeedPost = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const text = normalizeText(element.innerText);
    if (text.length < 45) {
      return false;
    }
    const postLinkCount = element.querySelectorAll(POST_LINK_SELECTORS).length;
    const hasAuthorLink = Boolean(
      element.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')
    );
    const actionCount = element.querySelectorAll(ACTION_SELECTORS).length;
    return hasAuthorLink || actionCount >= 2 || postLinkCount >= 1;
  };

  const findContainerFromElement = (element) => {
    let current = element instanceof Element ? element : null;
    while (current && current !== document.body) {
      if (current instanceof HTMLElement) {
        const textLength = normalizeText(current.innerText).length;
        const isReasonableCardSize = textLength >= 45 && textLength <= 6000;
        if (
          current.matches(POST_CONTAINER_SELECTORS) ||
          (isReasonableCardSize && looksLikeFeedPost(current))
        ) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  };

  const findFallbackContainerForLink = (link) => {
    let current = link instanceof Element ? link.parentElement : null;
    while (current && current !== document.body) {
      if (current instanceof HTMLElement) {
        const textLength = normalizeText(current.innerText).length;
        const postLinkCount = current.querySelectorAll(POST_LINK_SELECTORS).length;
        if (textLength >= 45 && textLength <= 6000 && postLinkCount >= 1) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return null;
  };

  const findPostContainers = () => {
    const containers = [];
    const seen = new Set();

    document.querySelectorAll(POST_CONTAINER_SELECTORS).forEach((element) => {
      if (!(element instanceof HTMLElement) || seen.has(element)) {
        return;
      }
      if (
        element.matches('article') ||
        element.querySelector(POST_LINK_SELECTORS) ||
        element.querySelector(PRIMARY_TEXT_SELECTORS) ||
        element.querySelector(AUTHOR_SELECTORS)
      ) {
        if (shouldSkipContainer(element)) {
          return;
        }
        seen.add(element);
        containers.push(element);
      }
    });

    document.querySelectorAll(POST_LINK_SELECTORS).forEach((link) => {
      const container =
        link.closest(POST_CONTAINER_SELECTORS) ||
        findContainerFromElement(link) ||
        findFallbackContainerForLink(link);
      if (container instanceof HTMLElement && !seen.has(container)) {
        if (shouldSkipContainer(container)) {
          return;
        }
        seen.add(container);
        containers.push(container);
      }
    });

    document.querySelectorAll(ACTION_SELECTORS).forEach((action) => {
      const container = findContainerFromElement(action);
      if (container instanceof HTMLElement && !seen.has(container)) {
        if (shouldSkipContainer(container)) {
          return;
        }
        seen.add(container);
        containers.push(container);
      }
    });

    return containers;
  };

  const resetExtractionAttempts = () => {
    extractionAttempts = 0;
    if (extractionRetryId !== null) {
      window.clearTimeout(extractionRetryId);
      extractionRetryId = null;
    }
  };

  const queueExtractionRetry = () => {
    if (extractionRetryId !== null || extractionAttempts >= MAX_PRE_HIDE_ATTEMPTS) {
      return;
    }
    extractionRetryId = window.setTimeout(() => {
      extractionRetryId = null;
      scheduleCheck();
    }, EXTRACTION_RETRY_MS);
  };

  const findPostUrl = (postElement) => {
    const directLink = postElement.querySelector(POST_LINK_SELECTORS);
    if (directLink instanceof HTMLAnchorElement && directLink.href) {
      return directLink.href;
    }
    const permalink = postElement.querySelector(
      'a[href*="urn:li:activity:"], a[href*="urn%3Ali%3Aactivity"], a[href*="activity:"]'
    );
    if (permalink instanceof HTMLAnchorElement && permalink.href) {
      return permalink.href;
    }
    const timeEl = postElement.querySelector('time');
    const timeLink = timeEl && timeEl.closest('a');
    if (timeLink instanceof HTMLAnchorElement && timeLink.href && timeLink.href.includes('linkedin.com')) {
      return timeLink.href;
    }
    const anyLi = postElement.querySelector('a[href*="linkedin.com/feed/update"], a[href*="linkedin.com/posts"]');
    if (anyLi instanceof HTMLAnchorElement && anyLi.href) {
      return anyLi.href;
    }
    return '';
  };

  const isFeedPage = () => {
    if (!LINKEDIN_HOSTNAMES.has(window.location.hostname)) {
      return false;
    }
    return window.location.pathname === '/' || window.location.pathname.startsWith(FEED_PATH_PREFIX);
  };

  const hideElement = (element) => {
    if (!previousDisplay.has(element)) {
      previousDisplay.set(element, element.style.getPropertyValue('display'));
    }
    element.style.setProperty('display', 'none', 'important');
    hiddenElements.add(element);
  };

  const restoreElement = (element) => {
    const prior = previousDisplay.get(element);
    if (typeof prior === 'string' && prior.length > 0) {
      element.style.setProperty('display', prior);
    } else {
      element.style.removeProperty('display');
    }
    previousDisplay.delete(element);
    hiddenElements.delete(element);
  };

  const revealFeed = () => {
    Array.from(hiddenElements).forEach((element) => {
      restoreElement(element);
    });
  };

  const collectFeedContainers = () => {
    const containers = [];
    const seen = new Set();
    FEED_SELECTORS.forEach((selector) => {
      const matches = document.querySelectorAll(selector);
      matches.forEach((element) => {
        if (!seen.has(element) && element instanceof HTMLElement) {
          seen.add(element);
          containers.push(element);
        }
      });
    });
    const contentBased = findFeedByContent();
    if (contentBased && !seen.has(contentBased)) {
      containers.push(contentBased);
    }
    if (containers.length === 0) {
      const main = document.querySelector('main');
      if (main && !seen.has(main)) {
        containers.push(main);
      }
    }
    return containers;
  };

  const ensureNotificationStyles = () => {
    if (document.getElementById(NOTIFICATION_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = NOTIFICATION_STYLE_ID;
    style.textContent = NOTIFICATION_STYLE;
    (document.head || document.documentElement).appendChild(style);
  };

  const hideNotifications = () => {
    ensureNotificationStyles();
    NOTIFICATION_SELECTORS.forEach((selector) => {
      const matches = document.querySelectorAll(selector);
      matches.forEach((element) => {
        if (!(element instanceof HTMLElement)) {
          return;
        }
        const navItem =
          element.closest('li.global-nav__primary-item') ||
          element.closest('div.global-nav__primary-item') ||
          element.closest('li') ||
          element;
        if (navItem instanceof HTMLElement) {
          navItem.style.setProperty('display', 'none', 'important');
        }
      });
    });
  };

  const extractFeedPosts = () => {
    if (!isFeedPage()) {
      void buildDebugSnapshot({
        phase: 'extract-skip',
        status: 'not-feed-page',
        url: window.location.href
      });
      return [];
    }

    const posts = [];
    const seen = new Set();

    const postElements = findPostContainers();

    postElements.forEach((postElement) => {
      try {
        const author = firstNonEmptyText(postElement, AUTHOR_SELECTORS) || findFallbackAuthor(postElement);
        const context = firstNonEmptyText(postElement, CONTEXT_SELECTORS);
        const textCandidates = buildTextCandidates(postElement, author, context);
        const usableTextCandidates = textCandidates.filter((text) => {
          const lower = text.toLowerCase();
          return !NOISE_FRAGMENTS.some((fragment) => lower.includes(fragment));
        });
        const titleSource =
          usableTextCandidates.find((text) => text.length >= 32) ||
          usableTextCandidates.find((text) => text.length >= 18) ||
          usableTextCandidates[0] ||
          '';
        const fullText = [...usableTextCandidates.slice(0, 3), context].filter(Boolean).join('\n');
        let url = findPostUrl(postElement);
        const bodyFingerprint = normalizeText(postElement.innerText).slice(0, 200);
        if (!url || url.includes('/admin/')) {
          url = makeSyntheticPostUrl(author, titleSource, bodyFingerprint);
        }
        const rawText = normalizeText(postElement.innerText).slice(0, 160);
        const identifier = url || `${author}::${titleSource}` || rawText;

        if (!titleSource || !identifier || seen.has(identifier)) {
          return;
        }

        seen.add(identifier);
        const reactionsEl = postElement.querySelector('.social-counts-reactions__count-value, [data-test-id="social-actions__reaction-count"], .reactions-count');
        const commentsEl = postElement.querySelector('.social-counts-comments, [data-test-id="social-actions__comments-count"]');
        const reactionCount = reactionsEl ? reactionsEl.textContent.trim() : '';
        const commentCount = commentsEl ? commentsEl.textContent.trim() : '';
        posts.push({
          title: titleSource.substring(0, 200) + (titleSource.length > 200 ? '...' : ''),
          fullText,
          author,
          context,
          reactionCount,
          commentCount,
          url,
          position: posts.length
        });
      } catch (error) {
        console.error('[linkedin-feed-blocker] Failed to extract post:', error);
        reportScriptError('extract-post', error);
      }
    });

    void buildDebugSnapshot({
      url: window.location.href,
      isFeedPage: true,
      postElementCount: postElements.length,
      extractedPostCount: posts.length,
      articleCount: document.querySelectorAll('article').length,
      postLinkCount: document.querySelectorAll(POST_LINK_SELECTORS).length,
      sampleTitles: posts.slice(0, 3).map((post) => post.title)
    });

    // Capture recommendations for tracking
    if (posts.length > 0 && window.RecommendationTracker) {
      window.RecommendationTracker.capture('linkedin', posts).catch(err => {
        console.error('[linkedin-feed-blocker] Failed to track recommendations:', err);
      });
    }

    return posts;
  };

  // ─── Focus Feed injection ──────────────────────────────────────────────────

  const FF_SUMMARIZE_API = 'https://feed-blocking-server.fly.dev/summarize';
  const FF_STORAGE_KEY = 'feed_recommendations';
  const FF_CACHE_KEY = 'feed_summary_brief';
  const FF_SEEN_KEY = 'feed_seen_topics';
  const FF_TOOL_KEY = 'feed_research_tool';
  const FF_MODEL_KEY = 'feed_summary_model';
  const FF_SEEN_TTL = 48 * 60 * 60 * 1000;
  const FF_RESEARCH_TOOLS = {
    perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
    grok: (q) => `https://x.com/i/grok?text=${encodeURIComponent(q)}`,
    chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  };
  const SUMMARY_MODELS = [
    'google/gemini-3.1-flash-lite-preview',
    'google/gemini-3-flash-preview'
  ];
  const normalizeSummaryModel = (value) => (SUMMARY_MODELS.includes(value) ? value : SUMMARY_MODELS[0]);

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
          captured_at: new Date(entry.timestamp || Date.now()).toISOString()
        });
      });
    });
    return items;
  };

  const createItemSignature = (items, model) => items
    .map((item) => `${item.platform || ''}:${item.title || ''}:${item.url || ''}`)
    .sort()
    .join('|') + `::${normalizeSummaryModel(model)}`;

  let ffRefreshing = false;

  const ffOpenFullFeedPage = () => {
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

  const ffEsc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ffCap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const ffAge = (ts) => {
    if (!ts) return '';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return 'yesterday';
  };

  const ffInjectStyles = () => {
    if (document.getElementById('ff-li-styles')) return;
    const s = document.createElement('style');
    s.id = 'ff-li-styles';
    s.textContent = `
      #ff-li-container {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #1b1f23;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.1);
        margin-bottom: 8px;
        overflow: hidden;
      }
      .ffli-header { padding: 14px 16px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .ffli-header-copy { flex: 1; min-width: 0; }
      .ffli-eyebrow { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #f4a81d; margin: 0 0 4px; }
      .ffli-headline { font-size: 18px; font-weight: 600; line-height: 1.2; letter-spacing: -0.02em; color: #fff; margin: 0 0 3px; }
      .ffli-deck { font-size: 13px; color: #8899a6; margin: 0; }
      .ffli-refresh { flex-shrink: 0; padding: 5px 12px; border-radius: 999px; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: #8899a6; font-size: 12px; font-family: inherit; cursor: pointer; margin-top: 2px; }
      .ffli-refresh:hover:not(:disabled) { border-color: rgba(255,255,255,0.3); color: #fff; }
      .ffli-refresh:disabled { opacity: 0.4; cursor: not-allowed; }
      .ffli-topic { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); transition: background 0.12s; }
      .ffli-topic:last-of-type { border-bottom: none; }
      .ffli-topic:hover { background: rgba(255,255,255,0.03); }
      .ffli-topic-body { flex: 1; min-width: 0; }
      .ffli-topic-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #f4a81d; margin: 0 0 3px; }
      .ffli-topic-liner { font-size: 14px; line-height: 1.5; color: #e7e9ea; margin: 0 0 4px; }
      .ffli-topic-meta { font-size: 11px; color: #536471; margin: 0; }
      .ffli-explore { flex-shrink: 0; margin-top: 1px; padding: 5px 12px; border-radius: 999px; background: transparent; border: 1px solid rgba(255,255,255,0.15); color: #70b7f0; font-size: 12px; font-weight: 500; font-family: inherit; cursor: pointer; white-space: nowrap; }
      .ffli-explore:hover { background: rgba(112,183,240,0.1); border-color: rgba(112,183,240,0.35); }
      .ffli-footer { padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.07); }
      .ffli-footer-label { font-size: 11px; color: #536471; }
      .ffli-open-full { font-size: 12px; color: #70b7f0; background: none; border: none; cursor: pointer; font-family: inherit; font-weight: 500; padding: 0; }
      .ffli-open-full:hover { text-decoration: underline; }
      .ffli-state { padding: 36px 24px; text-align: center; }
      .ffli-state-title { font-size: 16px; font-weight: 600; color: #fff; margin: 0 0 6px; }
      .ffli-state-sub { font-size: 13px; color: #536471; max-width: 280px; margin: 0 auto; line-height: 1.5; }
      .ffli-quiet { padding: 36px 24px; text-align: center; background: rgba(244,168,29,0.04); border-bottom: 1px solid rgba(255,255,255,0.07); }
      .ffli-quiet-title { font-size: 20px; font-weight: 700; color: #fff; margin: 0 0 6px; letter-spacing: -0.02em; }
      .ffli-quiet-since { font-size: 13px; color: #8899a6; margin: 0 0 4px; line-height: 1.5; }
      .ffli-quiet-permission { font-size: 12px; color: #536471; margin: 0; font-style: italic; }
      .ffli-spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.1); border-top-color: #70b7f0; border-radius: 50%; animation: ffli-spin 0.8s linear infinite; margin: 0 auto 10px; }
      @keyframes ffli-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(s);
  };

  const ffGetOrCreateContainer = () => {
    const existing = document.getElementById('ff-li-container');
    if (existing) return existing;
    const container = document.createElement('div');
    container.id = 'ff-li-container';
    const listContainer = document.querySelector('div.scaffold-layout__list-container, div.scaffold-layout__list');
    if (listContainer && listContainer.parentElement) {
      listContainer.parentElement.insertBefore(container, listContainer);
      return container;
    }
    const main = document.querySelector('main.scaffold-layout__main, div.scaffold-layout__main, main');
    if (main) {
      main.prepend(container);
      return container;
    }
    const feedOutlet = document.querySelector('div.feed-outlet, [data-id="main-feed"], section.feed-container');
    if (feedOutlet && feedOutlet.parentElement) {
      feedOutlet.parentElement.insertBefore(container, feedOutlet);
      return container;
    }
    const contentBased = findFeedByContent();
    if (contentBased && contentBased.parentElement) {
      contentBased.parentElement.insertBefore(container, contentBased);
      return container;
    }
    if (document.body) {
      const anchor = document.body.querySelector('main, [role="main"], #main') || document.body;
      anchor.insertBefore(container, anchor.firstChild);
      return container;
    }
    document.documentElement.appendChild(container);
    return container;
  };

  const ffRenderLoading = (c) => { c.innerHTML = `<div class="ffli-state"><div class="ffli-spinner"></div><p class="ffli-state-title">Building your brief…</p><p class="ffli-state-sub">Pulling signal from your recent browsing.</p></div>`; };
  const ffRenderNoData = (c) => { c.innerHTML = `<div class="ffli-state"><p class="ffli-state-title">No feed data yet</p><p class="ffli-state-sub">Browse LinkedIn for a bit to collect signal, then your brief will appear here.</p></div>`; };

  const ffRenderNothingNew = (c, meta, tool) => {
    const since = (meta && meta.headline) ? `"${ffEsc(meta.headline)}"` : 'your last brief';
    const age = meta && meta.timestamp ? ffAge(meta.timestamp) : '';
    c.innerHTML = `
      <div class="ffli-header" style="border-bottom:none;padding-bottom:0;">
        <div class="ffli-header-copy"><p class="ffli-eyebrow">Talk of the Town</p></div>
        <button class="ffli-refresh" id="ffli-refresh">Refresh</button>
      </div>
      <div class="ffli-quiet">
        <p class="ffli-quiet-title">All quiet.</p>
        <p class="ffli-quiet-since">Nothing new since ${since}${age ? ` — ${age}` : ''}.</p>
        <p class="ffli-quiet-permission">You're up to date. Good time to close this tab.</p>
      </div>
      <div class="ffli-footer">
        <span class="ffli-footer-label">Your feed is collected as you browse</span>
        <button class="ffli-open-full" id="ffli-open-full">Open full feed ↗</button>
      </div>
    `;
    c.querySelector('#ffli-refresh').addEventListener('click', () => ffHandleRefresh(c, tool));
    c.querySelector('#ffli-open-full').addEventListener('click', ffOpenFullFeedPage);
  };

  const ffRenderBrief = (c, summary, tool, generatedAt) => {
    const topics = summary.topics || [];
    const headline = (summary.overview && summary.overview.headline) || 'Your feed, distilled.';
    const allPlatforms = [...new Set(topics.flatMap((t) => (t.signals && t.signals.platforms) || []))];
    const deck = topics.length > 0 ? `${topics.length} topic${topics.length !== 1 ? 's' : ''} · ${allPlatforms.join(', ') || 'your feeds'}` : '';

    const topicsHtml = topics.map((topic, i) => {
      const sig = topic.signals || {};
      const platforms = Array.isArray(sig.platforms) ? sig.platforms : [];
      const freshness = ffCap(sig.freshness || 'Recent');
      const count = sig.item_count || 0;
      const meta = [freshness, platforms.join(' · '), count ? `${count} item${count !== 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
      return `
        <div class="ffli-topic">
          <div class="ffli-topic-body">
            ${topic.title ? `<p class="ffli-topic-label">${ffEsc(topic.title)}</p>` : ''}
            <p class="ffli-topic-liner">${ffEsc(topic.one_liner || topic.title || '')}</p>
            <p class="ffli-topic-meta">${ffEsc(meta)}</p>
          </div>
          <button class="ffli-explore" data-idx="${i}">Explore →</button>
        </div>
      `;
    }).join('');

    c.innerHTML = `
      <div class="ffli-header">
        <div class="ffli-header-copy">
          <p class="ffli-eyebrow">Talk of the Town</p>
          <h2 class="ffli-headline">${ffEsc(headline)}</h2>
          ${deck ? `<p class="ffli-deck">${ffEsc(deck)}</p>` : ''}
        </div>
        <button class="ffli-refresh" id="ffli-refresh">Refresh</button>
      </div>
      ${topicsHtml}
      <div class="ffli-footer">
        <span class="ffli-footer-label">${generatedAt ? `Updated ${ffEsc(ffAge(generatedAt))}` : 'Collected from your recent browsing'}</span>
        <button class="ffli-open-full" id="ffli-open-full">Open full feed ↗</button>
      </div>
    `;
    c.querySelector('#ffli-refresh').addEventListener('click', () => ffHandleRefresh(c, tool));
    c.querySelector('#ffli-open-full').addEventListener('click', ffOpenFullFeedPage);
    c.querySelectorAll('.ffli-explore').forEach((btn) => {
      const idx = parseInt(btn.dataset.idx, 10);
      btn.addEventListener('click', () => {
        const t = topics[idx];
        const builder = FF_RESEARCH_TOOLS[tool] || FF_RESEARCH_TOOLS.perplexity;
        window.open(builder(`${t.title || t.one_liner || ''} recent`.trim()), '_blank');
      });
    });
  };

  const ffHandleRefresh = async (c, tool) => {
    if (ffRefreshing) return;
    ffRefreshing = true;
    const btn = c.querySelector('#ffli-refresh');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
      const stored = await chrome.storage.local.get([FF_STORAGE_KEY, FF_SEEN_KEY, FF_MODEL_KEY]);
      const data = stored[FF_STORAGE_KEY] || [];
      if (!data.length) { ffRenderNoData(c); return; }
      const items = flattenStoredItems(data);
      if (!items.length) { ffRenderNoData(c); return; }
      const seenEntries = (stored[FF_SEEN_KEY] || []).filter((e) => e.seenAt && (Date.now() - e.seenAt) < FF_SEEN_TTL);
      const model = normalizeSummaryModel(stored[FF_MODEL_KEY]);
      const res = await fetch(FF_SUMMARIZE_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, summary_model: model, seen_topics: seenEntries.map((e) => e.title) }) });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const result = await res.json();
      if (result.nothing_new) {
        const sig = createItemSignature(items, model);
        await chrome.storage.local.set({ [FF_CACHE_KEY]: { signature: sig, summary: result } });
        const m = await chrome.storage.local.get('feed_last_brief_meta');
        ffRenderNothingNew(c, m['feed_last_brief_meta'], tool);
        return;
      }
      if (result.topics && result.topics.length > 0) {
        const sig = createItemSignature(items, model);
        await chrome.storage.local.set({ [FF_CACHE_KEY]: { signature: sig, summary: result } });
        if (result.overview && result.overview.headline) await chrome.storage.local.set({ feed_last_brief_meta: { headline: result.overview.headline, timestamp: Date.now() } });
        ffRenderBrief(c, result, tool, Date.now());
      } else { ffRenderNoData(c); }
    } catch (err) {
      console.error('[ff-li] refresh failed:', err);
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    } finally { ffRefreshing = false; }
  };

  const ffLoadAndRender = async (c) => {
    ffRenderLoading(c);
    const stored = await chrome.storage.local.get([FF_CACHE_KEY, FF_STORAGE_KEY, FF_TOOL_KEY, FF_MODEL_KEY, 'feed_last_brief_meta']);
    const tool = stored[FF_TOOL_KEY] || 'perplexity';
    const cached = stored[FF_CACHE_KEY];
    const meta = stored['feed_last_brief_meta'] || null;
    const generatedAt = meta && meta.timestamp ? meta.timestamp : null;
    const data = stored[FF_STORAGE_KEY] || [];
    const items = flattenStoredItems(data);
    const model = normalizeSummaryModel(stored[FF_MODEL_KEY]);
    const signature = createItemSignature(items, model);

    if (cached && cached.summary && cached.signature === signature) {
      if (cached.summary.nothing_new) { ffRenderNothingNew(c, meta, tool); }
      else if (cached.summary.topics && cached.summary.topics.length > 0) { ffRenderBrief(c, cached.summary, tool, generatedAt); }
      else { ffRenderNoData(c); }
      return;
    }

    if (data.length > 0 && items.length > 0) {
      await ffHandleRefresh(c, tool);
    } else {
      ffRenderNoData(c);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────

  const hideFeed = () => {
    try {
      if (!isFeedPage()) {
        resetExtractionAttempts();
        if (storageDebounceId !== null) {
          window.clearTimeout(storageDebounceId);
          storageDebounceId = null;
        }
        revealFeed();
        hideNotifications();
        const existing = document.getElementById('ff-li-container');
        if (existing) existing.remove();
        return;
      }

      const posts = extractFeedPosts();

      if (posts.length === 0) {
        extractionAttempts += 1;
        void buildDebugSnapshot({
          phase: 'hide-feed',
          status: 'retrying',
          url: window.location.href,
          extractionAttempts,
          articleCount: document.querySelectorAll('article').length,
          actionCount: document.querySelectorAll(ACTION_SELECTORS).length,
          postLinkCount: document.querySelectorAll(POST_LINK_SELECTORS).length,
          ffContainerPresent: Boolean(document.getElementById('ff-li-container'))
        });
        hideNotifications();
        if (extractionAttempts >= MAX_PRE_HIDE_ATTEMPTS) {
          ffInjectStyles();
          const ffContainer = ffGetOrCreateContainer();
          if (!ffContainer) {
            void buildDebugSnapshot({
              phase: 'inject',
              status: 'no-mount-point',
              url: window.location.href,
              hasBody: Boolean(document.body),
              hasMain: Boolean(document.querySelector('main'))
            });
            if (injectMountRetryId === null) {
              injectMountRetryId = window.setTimeout(() => {
                injectMountRetryId = null;
                scheduleCheck();
              }, EXTRACTION_RETRY_MS);
            }
            return;
          }
          const containers = collectFeedContainers();
          containers.forEach((container) => hideElement(container));
          hideNotifications();
          if (!ffContainer.dataset.loaded) {
            ffContainer.dataset.loaded = '1';
            ffLoadAndRender(ffContainer);
          }
          return;
        }
        queueExtractionRetry();
        return;
      }

      resetExtractionAttempts();

      const containers = collectFeedContainers();
      if (containers.length === 0) {
        hideNotifications();
        return;
      }

      ffInjectStyles();
      const ffContainer = ffGetOrCreateContainer();
      if (!ffContainer) {
        void buildDebugSnapshot({
          phase: 'inject',
          status: 'no-mount-point-posts',
          url: window.location.href,
          postCount: posts.length
        });
        if (injectMountRetryId === null) {
          injectMountRetryId = window.setTimeout(() => {
            injectMountRetryId = null;
            scheduleCheck();
          }, EXTRACTION_RETRY_MS);
        }
        return;
      }

      containers.forEach((container) => hideElement(container));
      hideNotifications();

      if (!ffContainer.dataset.loaded) {
        ffContainer.dataset.loaded = '1';
        ffLoadAndRender(ffContainer);
      }
    } catch (error) {
      console.error('[linkedin-feed-blocker] hideFeed failed:', error);
      reportScriptError('hide-feed', error);
    }
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) {
      return;
    }
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      hideFeed();
    }, CHECK_DELAY_MS);
  };

  const initObservers = () => {
    if (mutationObserver || !document.body) {
      return;
    }
    mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          scheduleCheck();
          break;
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  };

  const interceptHistory = () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    const notify = () => {
      resetExtractionAttempts();
      scheduleCheck();
    };
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      notify();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      notify();
      return result;
    };
  };

  const init = () => {
    try {
      const scheduleBriefResync = () => {
        if (storageDebounceId !== null) {
          window.clearTimeout(storageDebounceId);
        }
        storageDebounceId = window.setTimeout(() => {
          storageDebounceId = null;
          if (!isFeedPage()) return;
          const c = document.getElementById('ff-li-container');
          if (c) {
            delete c.dataset.loaded;
            ffLoadAndRender(c);
          }
        }, 250);
      };

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[FF_CACHE_KEY] || changes[FF_STORAGE_KEY]) {
          scheduleBriefResync();
        }
      });
      console.info('[Feed Blocker] LinkedIn feed script active');
      void buildDebugSnapshot({
        phase: 'init',
        status: 'loaded',
        url: window.location.href,
        readyState: document.readyState,
        articleCount: document.querySelectorAll('article').length
      });
      hideFeed();
      initObservers();
      interceptHistory();
      window.addEventListener('popstate', scheduleCheck, { passive: true });
    } catch (error) {
      console.error('[linkedin-feed-blocker] init failed:', error);
      reportScriptError('init', error);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
