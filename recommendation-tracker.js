// Recommendation Tracker - Shared service for capturing and storing feed recommendations
(() => {
  const STORAGE_KEY = 'feed_recommendations';
  const MAX_ENTRIES = 1000; // Limit stored entries to prevent excessive storage use

  /**
   * Captures and stores feed recommendations
   * @param {string} platform - 'youtube', 'twitter', or 'linkedin'
   * @param {Array} recommendations - Array of recommendation objects
   */
  const captureRecommendations = async (platform, recommendations) => {
    if (!Array.isArray(recommendations) || recommendations.length === 0) {
      console.log(`[Tracker] No recommendations to capture for ${platform}`);
      return;
    }

    const entry = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      platform,
      url: window.location.href,
      count: recommendations.length,
      recommendations
    };

    try {
      // Get existing data
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const existingData = result[STORAGE_KEY] || [];

      // Add new entry
      existingData.push(entry);

      // Trim if exceeding max entries (keep most recent)
      if (existingData.length > MAX_ENTRIES) {
        existingData.splice(0, existingData.length - MAX_ENTRIES);
      }

      // Save back to storage
      await chrome.storage.local.set({ [STORAGE_KEY]: existingData });

      console.log(`[Tracker] Captured ${recommendations.length} recommendations from ${platform}`);
    } catch (error) {
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
