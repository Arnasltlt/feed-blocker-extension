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

  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();
  let scheduledCheckId = null;
  let mutationObserver;
  let titleListContainer = null;

  const isHomePage = () => {
    return window.location.hostname === HOME_HOSTNAME && window.location.pathname === HOME_PATHNAME;
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
      let href = '';
      if (anchor) {
        href = toAbsoluteUrl(anchor.getAttribute('href') || '');
      }
      if (!href && renderer) {
        href = getHrefFromRenderer(renderer);
      }
      if (!href) {
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
      const key = `${href}::${text}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      titles.push({ text, href });
    });
    return titles;
  };

  const createTitlePanel = (titles) => {
    const container = document.createElement('div');
    container.id = TITLE_LIST_ID;
    container.style.cssText =
      'padding: 20px; max-width: 1200px; margin: 0 auto; color: #fff; font-family: Roboto, Arial, sans-serif; position: relative; z-index: 9999; background-color: #0f0f0f; min-height: 200px;';
    if (titles.length === 0) {
      const message = document.createElement('p');
      message.textContent = PLACEHOLDER_TEXT;
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
      link.href = title.href;
      link.textContent = title.text;
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

  const removeTitleList = () => {
    const existing = document.getElementById(TITLE_LIST_ID);
    if (existing) {
      existing.remove();
    }
    titleListContainer = null;
  };

  const insertTitleList = (titles, feedContainer) => {
    removeTitleList();
    const titleList = createTitlePanel(titles);
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
    insertTitleList(titles, feedElements[0]);
    if (titles.length === 0) {
      scheduleCheck();
    }
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) {
      return;
    }
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      hideHomeFeed();
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
    hideHomeFeed();
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
