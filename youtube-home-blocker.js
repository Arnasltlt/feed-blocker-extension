(() => {
  const HOME_HOSTNAME = 'www.youtube.com';
  const HOME_PATHNAME = '/';
  const FEED_SELECTORS = [
    'ytd-rich-grid-renderer',
    '#primary ytd-rich-grid-renderer',
    '#contents ytd-rich-grid-renderer',
    '#primary ytd-rich-grid-row'
  ];
  const VIDEO_ITEM_SELECTOR = 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer';
  const WATCH_PATH_FRAGMENT = '/watch';
  const TITLE_LIST_ID = 'feed-blocker-title-list';
  const PLACEHOLDER_TEXT = 'Feed blocked. Titles will appear once YouTube is done loading.';
  const CHECK_DELAY_MS = 120;
  const RERANK_MESSAGE_TYPE = 'RERANK_VIDEOS';
  const MAX_RERANK_ITEMS = 30;
  const CUSTOM_FEED_TITLE = 'Custom feed (Groq)';
  const CUSTOM_FEED_DESCRIPTION = 'Videos reordered for deep, learning-focused sessions.';
  const LOADING_DESCRIPTION = 'Re-ranking your recommendations with Groq. This may take a moment.';
  const LOADING_MESSAGE = 'Generating custom feed via Groq...';
  const FALLBACK_DESCRIPTION = 'Could not reach the local Groq server. Showing the original YouTube order.';

  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();
  let scheduledCheckId = null;
  let mutationObserver;
  let titleListContainer = null;
  let latestRerankRequestId = 0;
  const rerankCache = new Map();
  let lastVideoHash = null;
  let rerankDebounceTimer = null;
  let lastRenderedGroups = null;
  const RERANK_DEBOUNCE_MS = 2000;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const SHOW_THUMBNAILS_KEY = 'feed-blocker-show-thumbnails';
  let showThumbnails = JSON.parse(localStorage.getItem(SHOW_THUMBNAILS_KEY) || 'false');
  const SHORTS_PATH_PREFIX = '/shorts';
  const SHORTS_OVERLAY_ID = 'feed-blocker-shorts-overlay';
  const SHORTS_OVERLAY_TITLE = 'Shorts blocked';
  const SHORTS_OVERLAY_DESCRIPTION =
    'Short-form distractions are hidden. Use Search or Subscriptions for long-form learning.';
  const SHORTS_PAGE_SELECTORS = ['ytd-shorts', '#shorts-player', '#shorts-container', 'ytd-reel-video-renderer'];
  const shortsHiddenElements = new Set();
  const shortsPreviousDisplay = new WeakMap();

  const isHomePage = () => {
    return window.location.hostname === HOME_HOSTNAME && window.location.pathname === HOME_PATHNAME;
  };

  const isShortsPage = () => {
    return window.location.hostname === HOME_HOSTNAME && window.location.pathname.startsWith(SHORTS_PATH_PREFIX);
  };

  const collectFeedElements = () => {
    if (!isHomePage()) {
      return [];
    }
    const homeContainer = document.querySelector('ytd-browse[page-subtype="home"]');
    if (!homeContainer) {
      return [];
    }
    const elements = [];
    const seen = new Set();
    FEED_SELECTORS.forEach((selector) => {
      const matches = homeContainer.querySelectorAll(selector);
      matches.forEach((element) => {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
      });
    });
    return elements;
  };

  const cleanupShortsHiddenElements = () => {
    Array.from(shortsHiddenElements).forEach((element) => {
      if (!element || !element.isConnected) {
        shortsHiddenElements.delete(element);
        shortsPreviousDisplay.delete(element);
      }
    });
  };

  const hideShortsElement = (element) => {
    if (!element || shortsHiddenElements.has(element)) {
      return;
    }
    const currentDisplay = element.style.getPropertyValue('display');
    shortsPreviousDisplay.set(element, currentDisplay);
    element.style.setProperty('display', 'none', 'important');
    element.setAttribute('data-feed-blocker-shorts-hidden', 'true');
    shortsHiddenElements.add(element);
  };

  const ensureShortsOverlay = () => {
    let overlay = document.getElementById(SHORTS_OVERLAY_ID);
    if (overlay) {
      return overlay;
    }
    if (!document.body) {
      return null;
    }
    overlay = document.createElement('div');
    overlay.id = SHORTS_OVERLAY_ID;
    overlay.style.cssText =
      'position: fixed; inset: 0; background-color: #0f0f0f; color: #fff; z-index: 99999; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 12px; padding: 32px;';
    const heading = document.createElement('h2');
    heading.textContent = SHORTS_OVERLAY_TITLE;
    heading.style.cssText = 'margin: 0; font-size: 28px; font-weight: 500;';
    const description = document.createElement('p');
    description.textContent = SHORTS_OVERLAY_DESCRIPTION;
    description.style.cssText = 'margin: 0; font-size: 16px; opacity: 0.85; max-width: 520px;';
    overlay.appendChild(heading);
    overlay.appendChild(description);
    document.body.appendChild(overlay);
    return overlay;
  };

  const removeShortsOverlay = () => {
    const overlay = document.getElementById(SHORTS_OVERLAY_ID);
    if (overlay) {
      overlay.remove();
    }
  };

  const collectShortsModules = () => {
    const modules = new Set();
    document.querySelectorAll('ytd-rich-section-renderer').forEach((section) => {
      if (section.querySelector('ytd-reel-shelf-renderer, ytd-reel-video-renderer, ytd-reel-item-renderer')) {
        modules.add(section);
      }
    });
    document
      .querySelectorAll('ytd-reel-shelf-renderer, ytd-reel-video-renderer, ytd-reel-item-renderer')
      .forEach((element) => {
        modules.add(element);
      });
    document
      .querySelectorAll('a[href^="/shorts"], a[href^="https://www.youtube.com/shorts"], a[href^="//www.youtube.com/shorts"]')
      .forEach((link) => {
        const renderer = link.closest(
          'ytd-rich-item-renderer,ytd-grid-video-renderer,ytd-compact-video-renderer,ytd-video-renderer'
        );
        if (renderer) {
          modules.add(renderer);
        }
      });
    return Array.from(modules);
  };

  const blockInlineShorts = () => {
    const modules = collectShortsModules();
    modules.forEach((element) => {
      hideShortsElement(element);
    });
  };

  const blockShortsPage = () => {
    if (!isShortsPage()) {
      removeShortsOverlay();
      return;
    }
    SHORTS_PAGE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        hideShortsElement(element);
      });
    });
    ensureShortsOverlay();
  };

  const blockShortsContent = () => {
    cleanupShortsHiddenElements();
    blockInlineShorts();
    blockShortsPage();
  };

  const toAbsoluteUrl = (href) => {
    if (!href) {
      return '';
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
    if (href.startsWith('/')) {
      return `https://${HOME_HOSTNAME}${href}`;
    }
    return `https://${HOME_HOSTNAME}/${href}`;
  };

  const getChildElements = (node) => {
    if (!node || !node.childNodes) {
      return [];
    }
    return Array.from(node.childNodes).filter(
      (child) => child && child.nodeType === Node.ELEMENT_NODE
    );
  };

  const getCandidateAnchors = (root) => {
    const anchors = [];
    if (!root) {
      return anchors;
    }
    const queue = [root];
    const visited = new Set();
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visited.has(node)) {
        continue;
      }
      visited.add(node);
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (typeof element.getAttribute === 'function') {
          const href = element.getAttribute('href');
          if (href) {
            anchors.push(element);
          }
        }
        if (element.shadowRoot) {
          queue.push(element.shadowRoot);
        }
        queue.push(...getChildElements(element));
      } else if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
        queue.push(...getChildElements(node));
      }
    }
    return anchors;
  };

  const looksLikeDuration = (text) => {
    const normalized = (text || '').trim().toUpperCase();
    if (!normalized) {
      return false;
    }
    if (normalized === 'LIVE') {
      return true;
    }
    return /^[0-9:\s]+$/.test(normalized);
  };

  const getAnchorTitle = (anchor) => {
    if (!anchor) {
      return '';
    }
    const explicit = anchor.getAttribute('title') || anchor.getAttribute('aria-label');
    if (explicit && explicit.trim().length > 0 && !looksLikeDuration(explicit)) {
      return explicit.trim();
    }
    if (anchor.textContent && anchor.textContent.trim().length > 0) {
      const text = anchor.textContent.trim();
      if (!looksLikeDuration(text)) {
        return text;
      }
    }
    return '';
  };

  const getVideoRendererFromSource = (source) => {
    if (!source || typeof source !== 'object') {
      return null;
    }
    if (source.videoRenderer) {
      return source.videoRenderer;
    }
    if (source.compactVideoRenderer) {
      return source.compactVideoRenderer;
    }
    if (source.richItemRenderer && source.richItemRenderer.content) {
      return getVideoRendererFromSource(source.richItemRenderer.content);
    }
    if (source.content) {
      return getVideoRendererFromSource(source.content);
    }
    return null;
  };

  const getVideoRenderer = (item) => {
    const sources = [
      item.content,
      item.data,
      item.__data,
      item.data?.content,
      item.__data?.content,
      item.content?.content
    ];
    for (const source of sources) {
      const renderer = getVideoRendererFromSource(source);
      if (renderer) {
        return renderer;
      }
    }
    return null;
  };

  const getTitleFromRenderer = (renderer) => {
    if (!renderer) {
      return '';
    }
    if (renderer.title?.simpleText) {
      return renderer.title.simpleText.trim();
    }
    if (Array.isArray(renderer.title?.runs)) {
      return renderer.title.runs.map((run) => run.text).join('').trim();
    }
    return '';
  };

  const getHrefFromRenderer = (renderer) => {
    if (!renderer) {
      return '';
    }
    if (renderer.videoId) {
      return `https://${HOME_HOSTNAME}/watch?v=${renderer.videoId}`;
    }
    return '';
  };

  const extractVideoTitles = () => {
    if (!isHomePage()) {
      return [];
    }
    const items = document.querySelectorAll(VIDEO_ITEM_SELECTOR);
    const titles = [];
    const seen = new Set();
    items.forEach((item) => {
      const renderer = getVideoRenderer(item);
      let anchor =
        item.querySelector('a#video-title-link, a#video-title, a.yt-simple-endpoint[href*="watch"]') || null;
      if (!anchor) {
        const candidates = getCandidateAnchors(item);
        anchor = candidates.find((element) => {
          const href = element.getAttribute('href') || '';
          return typeof href === 'string' && href.includes(WATCH_PATH_FRAGMENT);
        });
      }
      let url = '';
      if (anchor) {
        url = toAbsoluteUrl(anchor.getAttribute('href') || '');
      }
      if (!url && renderer) {
        url = getHrefFromRenderer(renderer);
      }
      if (!url) {
        return;
      }
      const titleNode =
        item.querySelector('yt-formatted-string#video-title, h3 yt-formatted-string, h3') || anchor;
      let text =
        getAnchorTitle(titleNode) ||
        getAnchorTitle(anchor) ||
        getTitleFromRenderer(renderer) ||
        '';
      if (!text || looksLikeDuration(text)) {
        text = getTitleFromRenderer(renderer);
      }
      if (!text || looksLikeDuration(text)) {
        return;
      }
      const key = `${url}::${text}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const channelNode =
        item.querySelector('#channel-name a, #channel-name yt-formatted-string, yt-formatted-string.ytd-channel-name') ||
        null;
      const channel =
        (channelNode && typeof channelNode.textContent === 'string' && channelNode.textContent.trim()) || '';
      titles.push({
        title: text,
        url,
        channel,
        position: titles.length
      });
    });
    return titles;
  };

  const createTitlePanel = (titles, options = {}) => {
    const { headerText = '', descriptionText = '', emptyMessage = PLACEHOLDER_TEXT } = options || {};
    const container = document.createElement('div');
    container.id = TITLE_LIST_ID;
    container.style.cssText =
      'padding: 20px; max-width: 1200px; margin: 0 auto; color: #fff; font-family: Roboto, Arial, sans-serif; position: relative; z-index: 9999; background-color: #0f0f0f; min-height: 200px;';
    if (headerText) {
      const heading = document.createElement('h2');
      heading.textContent = headerText;
      heading.style.cssText = 'margin: 0 0 12px; font-size: 20px; font-weight: 500;';
      container.appendChild(heading);
    }
    if (descriptionText) {
      const description = document.createElement('p');
      description.textContent = descriptionText;
      description.style.cssText = 'margin: 0 0 16px; font-size: 14px; opacity: 0.8;';
      container.appendChild(description);
    }
    if (titles.length === 0) {
      const message = document.createElement('p');
      message.textContent = emptyMessage || PLACEHOLDER_TEXT;
      message.style.cssText = 'font-size: 15px; opacity: 0.8; margin: 0;';
      container.appendChild(message);
      return container;
    }
    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; padding: 0; margin: 0;';
    for (const title of titles) {
      const listItem = document.createElement('li');
      listItem.style.cssText = 'margin-bottom: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1);';
      const link = document.createElement('a');
      link.href = title.url;
      link.textContent = title.title;
      link.style.cssText = 'color: #fff; text-decoration: none; font-size: 14px; display: block;';
      link.addEventListener('mouseenter', () => {
        link.style.textDecoration = 'underline';
      });
      link.addEventListener('mouseleave', () => {
        link.style.textDecoration = 'none';
      });
      listItem.appendChild(link);
      list.appendChild(listItem);
    }
    container.appendChild(list);
    return container;
  };

  const createGroupedPanel = (groups, options = {}) => {
    const { headerText = '', descriptionText = '', emptyMessage = PLACEHOLDER_TEXT } = options || {};
    const container = document.createElement('div');
    container.id = TITLE_LIST_ID;
    container.style.cssText =
      'padding: 20px; max-width: 1400px; margin: 0 auto; color: #fff; font-family: Roboto, Arial, sans-serif; position: relative; z-index: 9999; background-color: #0f0f0f; min-height: 200px;';
    if (headerText || descriptionText) {
      const headerRow = document.createElement('div');
      headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 12px;';
      const headingWrapper = document.createElement('div');
      if (headerText) {
        const heading = document.createElement('h2');
        heading.textContent = headerText;
        heading.style.cssText = 'margin: 0 0 6px; font-size: 20px; font-weight: 500;';
        headingWrapper.appendChild(heading);
      }
      if (descriptionText) {
        const description = document.createElement('p');
        description.textContent = descriptionText;
        description.style.cssText = 'margin: 0; font-size: 14px; opacity: 0.8;';
        headingWrapper.appendChild(description);
      }
      headerRow.appendChild(headingWrapper);

      const toggleWrapper = document.createElement('label');
      toggleWrapper.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer;';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = showThumbnails;
      toggle.addEventListener('change', () => {
        showThumbnails = toggle.checked;
        localStorage.setItem(SHOW_THUMBNAILS_KEY, JSON.stringify(showThumbnails));
        if (lastRenderedGroups && titleListContainer) {
          const parent = titleListContainer.parentNode;
          const referenceSibling = titleListContainer.nextSibling;
          removeTitleList();
          const groupedPanel = createGroupedPanel(lastRenderedGroups, {
            headerText: headerText || CUSTOM_FEED_TITLE,
            descriptionText: descriptionText || CUSTOM_FEED_DESCRIPTION
          });
          if (parent) {
            if (referenceSibling) {
              parent.insertBefore(groupedPanel, referenceSibling);
            } else {
              parent.appendChild(groupedPanel);
            }
          }
          titleListContainer = groupedPanel;
        } else {
          lastVideoHash = null;
          scheduleCheck();
        }
      });
      const thumbLabel = document.createElement('span');
      thumbLabel.textContent = 'Show thumbnails';
      toggleWrapper.appendChild(toggle);
      toggleWrapper.appendChild(thumbLabel);
      headerRow.appendChild(toggleWrapper);
      container.appendChild(headerRow);
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      const message = document.createElement('p');
      message.textContent = emptyMessage || PLACEHOLDER_TEXT;
      message.style.cssText = 'font-size: 15px; opacity: 0.8; margin: 0;';
      container.appendChild(message);
      return container;
    }

    const columnsWrapper = document.createElement('div');
    columnsWrapper.style.cssText =
      'display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; width: 100%;';

    groups.forEach((group, groupIndex) => {
      const section = document.createElement('section');
      section.style.cssText =
        'background-color: #181818; border-radius: 10px; padding: 14px; flex: 1 1 260px; max-width: 320px; min-width: 240px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); display: flex; flex-direction: column; max-height: 480px;';
      const sectionHeading = document.createElement('h3');
      sectionHeading.textContent = group.category || `Group ${groupIndex + 1}`;
      sectionHeading.style.cssText = 'margin: 0 0 10px; font-size: 16px; font-weight: 500;';
      section.appendChild(sectionHeading);

      const list = document.createElement('ul');
      list.style.cssText =
        'list-style: none; padding: 0; margin: 0; overflow-y: auto; flex: 1 1 auto; scrollbar-width: thin;';

      (group.videos || []).forEach((video) => {
        const listItem = document.createElement('li');
        listItem.style.cssText =
          'display: flex; gap: 8px; margin-bottom: 10px; padding: 8px; border-radius: 6px; background-color: rgba(255,255,255,0.05);';

        if (showThumbnails) {
          const videoId = extractVideoId(video.url);
          if (videoId) {
            const thumbnail = document.createElement('img');
            thumbnail.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
            thumbnail.alt = video.title;
            thumbnail.loading = 'lazy';
            thumbnail.style.cssText = 'width: 64px; height: 36px; object-fit: cover; border-radius: 4px; flex-shrink: 0;';
            listItem.appendChild(thumbnail);
          }
        }

        const contentWrapper = document.createElement('div');
        contentWrapper.style.cssText = 'display: flex; flex-direction: column;';

        const link = document.createElement('a');
        link.href = video.url;
        link.textContent = video.title;
        link.style.cssText = 'color: #fff; text-decoration: none; font-size: 14px;';
        link.addEventListener('mouseenter', () => {
          link.style.textDecoration = 'underline';
        });
        link.addEventListener('mouseleave', () => {
          link.style.textDecoration = 'none';
        });
        contentWrapper.appendChild(link);

        if (video.channel) {
          const channel = document.createElement('span');
          channel.textContent = video.channel;
          channel.style.cssText = 'font-size: 12px; opacity: 0.75; margin-top: 4px;';
          contentWrapper.appendChild(channel);
        }

        listItem.appendChild(contentWrapper);
        list.appendChild(listItem);
      });
      section.appendChild(list);
      columnsWrapper.appendChild(section);
    });

    container.appendChild(columnsWrapper);
    return container;
  };

  const removeTitleList = () => {
    const existing = document.getElementById(TITLE_LIST_ID);
    if (existing) {
      existing.remove();
    }
    titleListContainer = null;
  };

  const insertTitleList = (titles, feedContainer, options = {}) => {
    removeTitleList();
    const titleList = createTitlePanel(titles, options);
    if (feedContainer && feedContainer.parentNode) {
      feedContainer.parentNode.insertBefore(titleList, feedContainer);
    } else {
      const primaryContainer = document.querySelector('#primary');
      if (primaryContainer) {
        const contents = primaryContainer.querySelector('#contents') || primaryContainer;
        contents.appendChild(titleList);
      } else {
        const browseContainer = document.querySelector('ytd-browse[page-subtype="home"]');
        if (browseContainer) {
          browseContainer.appendChild(titleList);
        }
      }
    }
    titleListContainer = titleList;
  };

  const insertGroupedList = (groups, feedContainer, options = {}) => {
    removeTitleList();
    const groupedPanel = createGroupedPanel(groups, options);
    if (feedContainer && feedContainer.parentNode) {
      feedContainer.parentNode.insertBefore(groupedPanel, feedContainer);
    } else {
      const primaryContainer = document.querySelector('#primary');
      if (primaryContainer) {
        const contents = primaryContainer.querySelector('#contents') || primaryContainer;
        contents.appendChild(groupedPanel);
      } else {
        const browseContainer = document.querySelector('ytd-browse[page-subtype="home"]');
        if (browseContainer) {
          browseContainer.appendChild(groupedPanel);
        }
      }
    }
    titleListContainer = groupedPanel;
  };

  const showLoadingPanel = (feedContainer) => {
    insertTitleList(
      [],
      feedContainer,
      {
        headerText: CUSTOM_FEED_TITLE,
        descriptionText: LOADING_DESCRIPTION,
        emptyMessage: LOADING_MESSAGE
      }
    );
  };

  const sendMessageToBackground = (payload) => {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.id) {
        reject(new Error('Extension runtime is unavailable.'));
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: RERANK_MESSAGE_TYPE,
          payload
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          if (!response || response.ok !== true) {
            reject(new Error(response?.error || 'Background request failed.'));
            return;
          }
          resolve(response.data);
        }
      );
    });
  };

  const normalizeVideoEntry = (video, fallbackPosition = 0) => {
    if (!video || typeof video !== 'object') {
      return null;
    }
    const title = typeof video.title === 'string' ? video.title.trim() : '';
    const url = typeof video.url === 'string' ? video.url.trim() : '';
    if (!title || !url) {
      return null;
    }
    return {
      title,
      url,
      channel: typeof video.channel === 'string' ? video.channel.trim() : '',
      position:
        typeof video.position === 'number' && Number.isFinite(video.position)
          ? video.position
          : fallbackPosition
    };
  };

  const sanitizeGroupedResponse = (groupCandidates, allowedVideos) => {
    if (!Array.isArray(groupCandidates) || !Array.isArray(allowedVideos)) {
      return [];
    }
    const allowedByUrl = new Map();
    allowedVideos.forEach((video) => {
      if (video && typeof video.url === 'string') {
        allowedByUrl.set(video.url, video);
      }
    });
    const assigned = new Set();
    const sanitized = [];
    groupCandidates.forEach((group) => {
      if (!group || typeof group !== 'object') {
        return;
      }
      const category = typeof group.category === 'string' ? group.category.trim() : '';
      if (!category) {
        return;
      }
      const videos = [];
      (Array.isArray(group.videos) ? group.videos : []).forEach((item) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        if (!url || assigned.has(url) || !allowedByUrl.has(url)) {
          return;
        }
        const base = allowedByUrl.get(url);
        videos.push({
          title:
            (typeof item.title === 'string' && item.title.trim()) ||
            base.title ||
            item.title ||
            '',
          url: base.url,
          channel: base.channel || '',
          position: base.position
        });
        assigned.add(url);
      });
      if (videos.length > 0) {
        sanitized.push({
          category: category.slice(0, 80),
          videos
        });
      }
    });
    const remaining = allowedVideos.filter((video) => video && !assigned.has(video.url));
    if (remaining.length > 0) {
      sanitized.push({
        category: 'Other picks',
        videos: remaining
      });
    }
    return sanitized;
  };

  const cloneGroups = (groups) => {
    if (!Array.isArray(groups)) {
      return [];
    }
    return groups.map((group) => ({
      category: group.category,
      videos: group.videos.map((video) => ({ ...video }))
    }));
  };

  const appendRemainderGroup = (groups, remainderVideos) => {
    const cloned = cloneGroups(groups);
    if (Array.isArray(remainderVideos) && remainderVideos.length > 0) {
      cloned.push({
        category: 'More from YouTube',
        videos: remainderVideos.map((video, index) => ({
          title: video.title,
          url: video.url,
          channel: video.channel || '',
          position:
            typeof video.position === 'number'
              ? video.position
              : MAX_RERANK_ITEMS + index
        }))
      });
    }
    return cloned;
  };

  const createVideoHash = (videos) => {
    if (!Array.isArray(videos) || videos.length === 0) {
      return '';
    }
    const urls = videos.slice(0, MAX_RERANK_ITEMS).map((v) => v.url).sort().join('|');
    return urls;
  };

  const getCachedRerank = (videoHash) => {
    const cached = rerankCache.get(videoHash);
    if (!cached) {
      return null;
    }
    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL_MS) {
      rerankCache.delete(videoHash);
      return null;
    }
    return cloneGroups(cached.result);
  };

  const setCachedRerank = (videoHash, result) => {
    rerankCache.set(videoHash, {
      result: cloneGroups(result),
      timestamp: Date.now()
    });
    if (rerankCache.size > 10) {
      const oldestKey = rerankCache.keys().next().value;
      rerankCache.delete(oldestKey);
    }
  };

  const extractVideoId = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('youtu')) {
        if (parsed.pathname === '/watch') {
          return parsed.searchParams.get('v') || '';
        }
        const segments = parsed.pathname.split('/');
        return segments.pop() || segments.pop() || '';
      }
    } catch (error) {
      return '';
    }
    return '';
  };

  const prepareVideoPayload = (videos) => {
    if (!Array.isArray(videos)) {
      return { truncated: [], remainder: [], videoHash: '' };
    }
    const truncated = videos.slice(0, MAX_RERANK_ITEMS).map((video, index) => ({
      title: video.title,
      url: video.url,
      channel: video.channel || '',
      position: index
    }));
    const remainder = videos.slice(MAX_RERANK_ITEMS).map((video, index) => ({
      title: video.title,
      url: video.url,
      channel: video.channel || '',
      position: MAX_RERANK_ITEMS + index
    }));
    const videoHash = createVideoHash(truncated);
    return { truncated, remainder, videoHash };
  };

  const rerankVideos = async (payload) => {
    const { truncated, remainder, videoHash } = payload;
    if (!Array.isArray(truncated) || truncated.length === 0) {
      return null;
    }
    try {
      const response = await sendMessageToBackground({ videos: truncated });
      if (!response || !Array.isArray(response.groups)) {
        return null;
      }
      const curated = sanitizeGroupedResponse(response.groups, truncated);
      setCachedRerank(videoHash, curated);
      return appendRemainderGroup(curated, remainder);
    } catch (error) {
      console.error('[feed-blocker] Custom feed request failed:', error);
      return null;
    }
  };

  const updateFeedWithCustomList = (videos, feedContainer) => {
    if (!Array.isArray(videos) || videos.length === 0) {
      insertTitleList([], feedContainer);
      return;
    }
    const payload = prepareVideoPayload(videos);
    if (payload.truncated.length === 0) {
      insertTitleList(videos, feedContainer);
      return;
    }
    const currentHash = payload.videoHash || createVideoHash(videos);
    if (currentHash === lastVideoHash) {
      return;
    }
    lastVideoHash = currentHash;
    if (rerankDebounceTimer !== null) {
      clearTimeout(rerankDebounceTimer);
    }
    rerankDebounceTimer = window.setTimeout(() => {
      rerankDebounceTimer = null;
      latestRerankRequestId += 1;
      const requestId = latestRerankRequestId;
      const cached = getCachedRerank(payload.videoHash);
      if (cached) {
        const grouped = appendRemainderGroup(cached, payload.remainder);
        insertGroupedList(grouped, feedContainer, {
          headerText: CUSTOM_FEED_TITLE,
          descriptionText: CUSTOM_FEED_DESCRIPTION
        });
        return;
      }
      showLoadingPanel(feedContainer);
      rerankVideos(payload)
        .then((groupedResult) => {
          if (requestId !== latestRerankRequestId) {
            return;
          }
          const hasCustom = Array.isArray(groupedResult) && groupedResult.length > 0;
          if (hasCustom) {
        lastRenderedGroups = groupedResult ? cloneGroups(groupedResult) : null;
        insertGroupedList(groupedResult, feedContainer, {
              headerText: CUSTOM_FEED_TITLE,
              descriptionText: CUSTOM_FEED_DESCRIPTION
            });
            return;
          }
          lastRenderedGroups = null;
          insertTitleList(videos, feedContainer, {
            headerText: 'Original order (fallback)',
            descriptionText: FALLBACK_DESCRIPTION
          });
        })
        .catch((error) => {
          if (requestId !== latestRerankRequestId) {
            return;
          }
          console.error('[feed-blocker] Unable to render custom feed:', error);
          lastRenderedGroups = null;
          insertTitleList(videos, feedContainer, {
            headerText: 'Original order (fallback)',
            descriptionText: FALLBACK_DESCRIPTION
          });
        });
    }, RERANK_DEBOUNCE_MS);
  };

  const hideElement = (element) => {
    if (!previousDisplay.has(element)) {
      const currentDisplay = element.style.getPropertyValue('display');
      previousDisplay.set(element, currentDisplay);
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

  const revealHiddenFeed = () => {
    Array.from(hiddenElements).forEach((element) => {
      restoreElement(element);
    });
    removeTitleList();
    latestRerankRequestId += 1;
    lastVideoHash = null;
    if (rerankDebounceTimer !== null) {
      clearTimeout(rerankDebounceTimer);
      rerankDebounceTimer = null;
    }
  };

  const hideHomeFeed = () => {
    if (!isHomePage()) {
      revealHiddenFeed();
      return;
    }

    const feedElements = collectFeedElements();
    if (feedElements.length === 0) {
      removeTitleList();
      return;
    }

    const currentElements = new Set(feedElements);

    feedElements.forEach((element) => {
      hideElement(element);
    });

    Array.from(hiddenElements).forEach((element) => {
      if (!currentElements.has(element) || !element.isConnected) {
        restoreElement(element);
      }
    });

    const titles = extractVideoTitles();
    updateFeedWithCustomList(titles, feedElements[0]);
    if (titles.length === 0) {
      scheduleCheck();
    }
  };

  const enforceBlocking = () => {
    blockShortsContent();
    hideHomeFeed();
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) {
      return;
    }
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      enforceBlocking();
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

  const init = () => {
    enforceBlocking();
    initObservers();
    window.addEventListener('yt-navigate-finish', scheduleCheck, { passive: true });
    window.addEventListener('popstate', scheduleCheck, { passive: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
