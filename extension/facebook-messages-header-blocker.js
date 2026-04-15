(() => {
  const FB_HOSTNAME = 'www.facebook.com';
  const MESSAGES_PATH_PREFIX = '/messages';
  const BODY_CLASS = 'feed-blocker-on-messages';

  // Elements to hide via JS (catches dynamic/lazy-loaded content CSS may miss)
  const HIDE_SELECTORS = [
    'nav[aria-label="Facebook"]',
    '[role="navigation"][aria-label="Facebook"]',
    'div[role="navigation"][aria-label="Facebook"]',
    '[role="navigation"]:has([aria-label="Notifications"])',
    'a[aria-label="Facebook"]',
    '[aria-label="Search Facebook"]',
    '[role="combobox"][aria-label="Search Facebook"]',
    '[aria-label="Search Messenger"]',
    '[placeholder*="Search Facebook"]',
    '[placeholder*="Search Messenger"]',
    'div[data-pagelet="LeftRail"]',
    '[data-pagelet="LeftRail"]',
    '[data-pagelet="LeftColumn"]',
    '[data-pagelet="Stories"]',
    '[aria-label="Stories"]',
    '[data-pagelet="RightColumn"]',
    '[data-pagelet="RightRail"]',
    '[aria-label="Suggested for you"]',
    '[aria-label="Sponsored"]',
    '[data-pagelet*="RightColumn"]',
    '[data-pagelet*="RightRail"]',
    '[aria-label="Create a post"]',
    '[aria-label="Create post"]',
    '[data-pagelet="FeedComposer"]',
    '[data-pagelet*="FeedComposer"]',
    '[data-pagelet*="Ads"]',
    '[data-pagelet*="Ad"]',
    '[data-testid="ad_slot"]',
    '[role="dialog"][aria-label*="Notification"]',
    '[data-pagelet="Feed"]',
    '[data-pagelet="MainFeed"]',
    '[role="alert"]',
    '[data-pagelet="Toast"]',
    '[data-pagelet="Toaster"]'
  ];

  const CHECK_DELAY_MS = 150;
  const BANNER_HEIGHT = 36;
  let scheduledCheckId = null;
  let mutationObserver;
  const hiddenElements = new Set();
  const previousDisplay = new WeakMap();
  const shiftedElements = new Set();
  const previousMarginTop = new WeakMap();
  const shiftedProperty = new WeakMap();

  const isMessagesPage = () => {
    const host = window.location.hostname;
    const path = window.location.pathname;
    return (
      host === FB_HOSTNAME && path.startsWith(MESSAGES_PATH_PREFIX)
    );
  };

  const addBodyClass = () => {
    if (document.body) {
      document.body.classList.add(BODY_CLASS);
    }

  };

  const removeBodyClass = () => {
    if (document.body) {
      document.body.classList.remove(BODY_CLASS);
    }
  };

  const hideElement = (element) => {
    if (hiddenElements.has(element)) {
      return;
    }
    previousDisplay.set(element, element.style.getPropertyValue('display'));
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

  const shiftElementUp = (element, deltaPx) => {
    if (deltaPx <= 0) {
      return;
    }
    const pos = getComputedStyle(element).position;
    const useTop = pos === 'fixed' || pos === 'sticky' || pos === 'relative' || pos === 'absolute';
    const prop = useTop ? 'top' : 'margin-top';
    if (!shiftedElements.has(element)) {
      previousMarginTop.set(element, element.style.getPropertyValue(prop));
      shiftedProperty.set(element, prop);
      shiftedElements.add(element);
    }
    if (useTop) {
      const currentTop = parseFloat(getComputedStyle(element).top) || 0;
      element.style.setProperty('top', `${currentTop - deltaPx}px`, 'important');
    } else {
      element.style.setProperty('margin-top', `${-deltaPx}px`, 'important');
    }
  };

  const restoreShiftedElements = () => {
    Array.from(shiftedElements).forEach((element) => {
      const prior = previousMarginTop.get(element);
      const prop = shiftedProperty.get(element) || 'margin-top';
      if (typeof prior === 'string' && prior.length > 0) {
        element.style.setProperty(prop, prior);
      } else {
        element.style.removeProperty(prop);
      }
      previousMarginTop.delete(element);
      shiftedProperty.delete(element);
      shiftedElements.delete(element);
    });
  };

  const BANNER_ID = 'messenger-lite-banner';
  const BANNER_HOST_ATTR = 'data-messenger-lite-host';

  const injectBanner = () => {
    if (!document.body) return;
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.innerHTML =
        '<div class="mlb-bubble">' +
        '<div class="mlb-bubble-body"></div>' +
        '<span class="mlb-bolt">&#9889;</span>' +
        '</div>' +
        '<span class="mlb-title">Messenger Lite</span>' +
        '<span class="mlb-tag">Focus Mode</span>';
    }

    const host = document.querySelector(
      '[role="banner"], nav[aria-label="Messenger"], nav[aria-label="Facebook"]'
    );

    if (host instanceof HTMLElement) {
      host.setAttribute(BANNER_HOST_ATTR, '1');
      Array.from(host.children).forEach((child) => {
        if (child !== banner && child instanceof HTMLElement) {
          hideElement(child);
        }
      });
      if (banner.parentElement !== host) {
        host.prepend(banner);
      }
      return;
    }

    if (banner.parentElement !== document.body) {
      document.body.prepend(banner);
    }
  };

  const removeBanner = () => {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  };

  const revealAll = () => {
    Array.from(hiddenElements).forEach((element) => {
      restoreElement(element);
    });
    restoreShiftedElements();
    removeBodyClass();
    removeBanner();
  };

  const normalizeTopGap = () => {
    if (!document.body) {
      return;
    }

    // Facebook's Messenger layout uses a `position: relative; top: 56px` wrapper
    // to push content below the original 56px fixed header. When we hide the header
    // and replace it with a 36px banner, that 56px offset creates a gap. Zero it out.
    document.querySelectorAll('div').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const style = getComputedStyle(el);
      const topVal = parseFloat(style.top);
      if (style.position === 'relative' && topVal > BANNER_HEIGHT + 4) {
        shiftElementUp(el, topVal);
      }
    });

    // Also remove any padding-top on the main content wrapper that sits flush
    // against the banner — Facebook adds padding-top to offset the original header.
    const contentWrapper = document.elementFromPoint(
      Math.round(window.innerWidth / 2),
      BANNER_HEIGHT + 2
    );
    if (contentWrapper instanceof HTMLElement) {
      const padTop = parseFloat(getComputedStyle(contentWrapper).paddingTop);
      if (padTop > 4) {
        if (!shiftedElements.has(contentWrapper)) {
          previousMarginTop.set(contentWrapper, contentWrapper.style.getPropertyValue('padding-top'));
          shiftedProperty.set(contentWrapper, 'padding-top');
          shiftedElements.add(contentWrapper);
        }
        contentWrapper.style.setProperty('padding-top', '0px', 'important');
      }
    }
  };

  const hideNoise = () => {
    if (!isMessagesPage()) {
      stopTitleObserver();
      removeBanner();
      revealAll();
      return;
    }

    addBodyClass();
    initTitleObserver();
    injectBanner();

    HIDE_SELECTORS.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((element) => {
          if (element instanceof HTMLElement) {
            hideElement(element);
          }
        });
      } catch (_) {
        /* invalid selector */
      }
    });

    const searchEl = document.querySelector('[aria-label="Search Facebook"], [role="combobox"][aria-label="Search Facebook"]');
    if (searchEl) {
      let wrapper = searchEl.parentElement;
      while (wrapper && wrapper !== document.body) {
        const pos = getComputedStyle(wrapper).position;
        if (pos === 'fixed' || pos === 'sticky') {
          hideElement(wrapper);
          break;
        }
        wrapper = wrapper.parentElement;
      }
    }

    document.querySelectorAll('[data-pagelet]').forEach((el) => {
      const pagelet = el.getAttribute('data-pagelet') || '';
      if (
        /^(LeftRail|LeftColumn|RightRail|RightColumn|Stories|Feed|MainFeed|FeedComposer|Ads?)/i.test(pagelet) &&
        !/Message|Conversation|Chat/i.test(pagelet)
      ) {
        if (el instanceof HTMLElement) hideElement(el);
      }
    });

    normalizeTopGap();
  };

  const scheduleCheck = () => {
    if (scheduledCheckId !== null) {
      return;
    }
    scheduledCheckId = window.setTimeout(() => {
      scheduledCheckId = null;
      hideNoise();
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

  const TITLE_OVERRIDE = 'Messenger';
  let titleObserver = null;

  const stopTitleObserver = () => {
    if (titleObserver) {
      titleObserver.disconnect();
      titleObserver = null;
    }
  };

  const initTitleObserver = () => {
    if (!isMessagesPage()) {
      stopTitleObserver();
      return;
    }
    if (titleObserver) return;
    const setTitle = () => {
      if (document.title !== TITLE_OVERRIDE) {
        document.title = TITLE_OVERRIDE;
      }
    };
    setTitle();
    titleObserver = new MutationObserver(setTitle);
    const titleEl = document.querySelector('title');
    if (titleEl) {
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  };

  const interceptHistory = () => {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      scheduleCheck();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      scheduleCheck();
      return result;
    };
  };

  const init = () => {
    console.info('[Feed Blocker] Facebook messages lightweight mode active');
    hideNoise();
    initObservers();
    interceptHistory();
    window.addEventListener('popstate', scheduleCheck, { passive: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  if (!document.body && document.readyState === 'loading') {
    const bodyObserver = new MutationObserver(() => {
      if (document.body) {
        bodyObserver.disconnect();
        if (isMessagesPage()) addBodyClass();
      }
    });
    bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
