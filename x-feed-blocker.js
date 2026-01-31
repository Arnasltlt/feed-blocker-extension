(() => {
  const X_HOSTNAMES = new Set(['x.com', 'twitter.com']);
  const HOME_PATHS = new Set(['/', '/home', '/explore']);
  const FEED_SELECTORS = [
    'div[data-testid="primaryColumn"] section',
    'div[data-testid="primaryColumn"] div[aria-label="Timeline: Your Home Timeline"]',
    'main [aria-label="Timeline: Your Home Timeline"]',
    'main div[data-testid="column"] section'
  ];
  const ASIDE_SELECTORS = [
    '[data-testid="sidebarColumn"]',
    '[aria-label="Timeline: Trending now"]',
    '[aria-label="Timeline: Explore"]'
  ];
  const CHECK_DELAY_MS = 120;

  let scheduledCheckId = null;
  let mutationObserver;
  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();

  const isHomePage = () => {
    if (!X_HOSTNAMES.has(window.location.hostname)) {
      return false;
    }
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return HOME_PATHS.has(path) || path.startsWith('/home');
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

  const revealHidden = () => {
    Array.from(hiddenElements).forEach((element) => {
      restoreElement(element);
    });
  };

  const extractTweets = () => {
    if (!isHomePage()) {
      return [];
    }

    const tweets = [];
    const seen = new Set();

    // X/Twitter uses article elements for tweets
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    articles.forEach((article, index) => {
      try {
        // Extract tweet text
        const tweetTextElement = article.querySelector('[data-testid="tweetText"]');
        const text = tweetTextElement ? tweetTextElement.textContent.trim() : '';

        // Extract author
        const authorElement = article.querySelector('[data-testid="User-Name"] a[role="link"]');
        const author = authorElement ? authorElement.textContent.trim() : '';

        // Extract tweet URL
        const timeElement = article.querySelector('time');
        const linkElement = timeElement ? timeElement.closest('a') : null;
        const url = linkElement ? linkElement.href : '';

        if (!text || !url || seen.has(url)) {
          return;
        }

        seen.add(url);

        tweets.push({
          title: text.substring(0, 200) + (text.length > 200 ? '...' : ''), // Truncate long tweets
          fullText: text,
          author,
          url,
          position: tweets.length
        });
      } catch (error) {
        console.error('[x-feed-blocker] Failed to extract tweet:', error);
      }
    });

    // Capture recommendations for tracking
    if (tweets.length > 0 && window.RecommendationTracker) {
      window.RecommendationTracker.capture('twitter', tweets).catch(err => {
        console.error('[x-feed-blocker] Failed to track recommendations:', err);
      });
    }

    return tweets;
  };

  const hideFeeds = () => {
    if (!isHomePage()) {
      revealHidden();
      return;
    }

    // Extract tweets before hiding
    extractTweets();

    const feedNodes = new Set();
    FEED_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (node instanceof HTMLElement) {
          feedNodes.add(node);
        }
      });
    });
    ASIDE_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (node instanceof HTMLElement) {
          feedNodes.add(node);
        }
      });
    });
    if (feedNodes.size === 0) {
      return;
    }
    feedNodes.forEach((node) => {
      hideElement(node);
    });
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) {
      return;
    }
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      hideFeeds();
    }, CHECK_DELAY_MS);
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
    hideFeeds();
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
