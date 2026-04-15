// Recommendation Tracker - Shared service for capturing and storing feed recommendations
(() => {
  const STORAGE_KEY = 'feed_recommendations';
  const MAX_ENTRIES = 200; // Kept low to avoid kQuotaBytes in Atlas and other browsers with strict limits
  const MAX_ITEMS_PER_CAPTURE = 50;

  const clampText = (value, maxLength) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);

  const createRecommendationSignature = (items) => {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }
    return items
      .slice(0, 20)
      .map((item) => `${item.url || ''}::${item.title || ''}::${item.author || item.channel || ''}`)
      .join('|');
  };

  /**
   * Slims recommendation objects to reduce storage usage
   */
  const slimRecommendations = (platform, items) => {
    if (!Array.isArray(items)) return items;
    return items.slice(0, MAX_ITEMS_PER_CAPTURE).map((r, index) => ({
      title: clampText(r.title, 180),
      url: clampText(r.url, 240),
      channel: clampText(r.channel, 80),
      author: clampText(r.author, 80),
      fullText: clampText(r.fullText || r.text || r.title, platform === 'youtube' ? 220 : 420),
      context: clampText(r.context, 120),
      viewCount: clampText(r.viewCount, 30),
      likeCount: clampText(r.likeCount, 30),
      retweetCount: clampText(r.retweetCount, 30),
      replyCount: clampText(r.replyCount, 30),
      reactionCount: clampText(r.reactionCount, 30),
      commentCount: clampText(r.commentCount, 30),
      position: Number.isFinite(r.position) ? r.position : index
    }));
  };

  const saveWithRetry = async (data) => {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
      return true;
    } catch (err) {
      if (err?.message?.includes('Extension context invalidated')) return false;
      if (err?.message?.includes('QuotaExceededError') || err?.message?.includes('quota')) {
        return false; // Signal caller to trim and retry
      }
      throw err;
    }
  };

  /**
   * Captures and stores feed recommendations
   * @param {string} platform - 'youtube', 'twitter', or 'linkedin'
   * @param {Array} recommendations - Array of recommendation objects
   */
  const captureRecommendations = async (platform, recommendations) => {
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      return;
    }

    const slimmed = slimRecommendations(platform, recommendations).filter((item) => item.title);
    if (slimmed.length === 0) {
      return;
    }

    const signature = createRecommendationSignature(slimmed);
    const entry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      platform,
      url: window.location.href.slice(0, 200),
      signature,
      count: slimmed.length,
      recommendations: slimmed
    };

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      let existingData = result[STORAGE_KEY] || [];

      for (let index = existingData.length - 1; index >= 0; index -= 1) {
        const prior = existingData[index];
        if (prior && prior.platform === platform) {
          if (prior.signature === signature) {
            return;
          }
          break;
        }
      }

      existingData.push(entry);
      if (existingData.length > MAX_ENTRIES) {
        existingData = existingData.slice(-MAX_ENTRIES);
      }

      let ok = await saveWithRetry(existingData);
      if (!ok && existingData.length > 50) {
        existingData = existingData.slice(-50);
        ok = await saveWithRetry(existingData);
      }
      if (!ok && existingData.length > 10) {
        existingData = existingData.slice(-10);
        ok = await saveWithRetry(existingData);
      }

      if (ok) {
        console.log(`[Tracker] Captured ${slimmed.length} recommendations from ${platform}`);
      }
    } catch (error) {
      if (error?.message?.includes('Extension context invalidated')) return;
      console.error('[Tracker] Failed to store recommendations:', error);
    }
  };

  /**
   * Gets storage statistics
   */
  const getStats = async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY] || [];

      const stats = {
        totalCaptures: data.length,
        totalRecommendations: data.reduce((sum, entry) => sum + entry.count, 0),
        byPlatform: {},
        oldestCapture: data.length > 0 ? data[0].date : null,
        newestCapture: data.length > 0 ? data[data.length - 1].date : null
      };

      // Count by platform
      data.forEach(entry => {
        if (!stats.byPlatform[entry.platform]) {
          stats.byPlatform[entry.platform] = {
            captures: 0,
            recommendations: 0
          };
        }
        stats.byPlatform[entry.platform].captures++;
        stats.byPlatform[entry.platform].recommendations += entry.count;
      });

      return stats;
    } catch (error) {
      if (error?.message?.includes('Extension context invalidated')) {
        return null;
      }
      console.error('[Tracker] Failed to get stats:', error);
      return null;
    }
  };

  // Expose API
  window.RecommendationTracker = {
    capture: captureRecommendations,
    getStats
  };
})();
