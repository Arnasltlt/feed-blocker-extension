// Recommendation Tracker - Shared service for capturing and storing feed recommendations
(() => {
  const STORAGE_KEY = 'feed_recommendations';
  const MAX_ENTRIES = 200; // Kept low to avoid kQuotaBytes in Atlas and other browsers with strict limits

  /**
   * Slims recommendation objects to reduce storage usage
   */
  const slimRecommendations = (items) => {
    if (!Array.isArray(items)) return items;
    return items.slice(0, 50).map((r) => ({
      title: (r.title || '').slice(0, 120),
      url: (r.url || '').slice(0, 200),
      channel: (r.channel || '').slice(0, 80)
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

    const slimmed = slimRecommendations(recommendations);
    const entry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      platform,
      url: window.location.href.slice(0, 200),
      count: slimmed.length,
      recommendations: slimmed
    };

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      let existingData = result[STORAGE_KEY] || [];

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
