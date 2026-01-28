(() => {
  const LINKEDIN_HOSTNAME = 'www.linkedin.com';
  const FEED_PATH_PREFIX = '/feed';
  const NOTIFICATIONS_PATH_PREFIX = '/notifications';
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
  const NOTIFICATIONS_TEXT_ONLY_STYLE_ID = 'feed-blocker-linkedin-notifications-text-only';
  const NOTIFICATIONS_TEXT_ONLY_STYLE = `
    body {
      background: #ffffff !important;
      color: #202124 !important;
    }
    img,
    svg,
    video,
    canvas,
    picture,
    [class*="avatar"],
    [class*="Avatar"],
    [class*="photo"],
    [class*="Photo"],
    [class*="image"],
    [class*="Image"],
    [class*="logo"],
    [class*="Logo"],
    [class*="presence"],
    [class*="Presence"],
    [class*="status-indicator"],
    [class*="StatusIndicator"],
    [class*="badge"],
    [class*="Badge"] {
      display: none !important;
      visibility: hidden !important;
    }
    [class*="artdeco-card"],
    [class*="card"],
    [class*="Card"],
    [class*="nt-card"],
    [class*="notification"],
    [class*="Notification"],
    [class*="pill"],
    [class*="Pill"],
    [class*="chip"],
    [class*="Chip"] {
      background: transparent !important;
      box-shadow: none !important;
      border-radius: 0 !important;
    }
    [class*="selected"],
    [class*="active"],
    [class*="Active"],
    [class*="selectedTab"],
    [class*="SelectedTab"] {
      background: transparent !important;
      color: #202124 !important;
    }
    a,
    a:visited,
    button,
    [role="button"] {
      color: #202124 !important;
      background: transparent !important;
      box-shadow: none !important;
      border-color: #c0c0c0 !important;
      text-decoration: none !important;
    }
    main a,
    main a:visited {
      pointer-events: none !important;
      cursor: default !important;
    }
    * {
      text-decoration: none !important;
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

  let scheduledCheckId = null;
  let mutationObserver;
  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();

  const isFeedPage = () => {
    if (window.location.hostname !== LINKEDIN_HOSTNAME) {
      return false;
    }
    return window.location.pathname === '/' || window.location.pathname.startsWith(FEED_PATH_PREFIX);
  };

  const isNotificationsPage = () => {
    if (window.location.hostname !== LINKEDIN_HOSTNAME) {
      return false;
    }
    return window.location.pathname.startsWith(NOTIFICATIONS_PATH_PREFIX);
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

  const ensureNotificationsTextOnlyStyles = () => {
    if (document.getElementById(NOTIFICATIONS_TEXT_ONLY_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = NOTIFICATIONS_TEXT_ONLY_STYLE_ID;
    style.textContent = NOTIFICATIONS_TEXT_ONLY_STYLE;
    (document.head || document.documentElement).appendChild(style);
  };

  const removeNotificationsTextOnlyStyles = () => {
    const style = document.getElementById(NOTIFICATIONS_TEXT_ONLY_STYLE_ID);
    if (style) {
      style.remove();
    }
  };

  const hideFeed = () => {
    if (isNotificationsPage()) {
      revealFeed();
      ensureNotificationsTextOnlyStyles();
      return;
    }
    removeNotificationsTextOnlyStyles();
    if (!isFeedPage()) {
      revealFeed();
      return;
    }
    const containers = collectFeedContainers();
    if (containers.length === 0) {
      return;
    }
    containers.forEach((container) => {
      hideElement(container);
    });
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
    console.info('[Feed Blocker] LinkedIn feed script active');
    hideFeed();
    initObservers();
    interceptHistory();
    window.addEventListener('popstate', scheduleCheck, { passive: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
