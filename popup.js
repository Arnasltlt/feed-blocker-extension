const STORAGE_KEY = 'feed_recommendations';

// Load and display stats
async function loadStats() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY] || [];

    if (data.length === 0) {
      showEmptyState();
      return;
    }

    // Calculate stats
    const stats = {
      totalCaptures: data.length,
      totalRecommendations: data.reduce((sum, entry) => sum + entry.count, 0),
      byPlatform: {},
      oldestCapture: data[0].date,
      newestCapture: data[data.length - 1].date
    };

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

    displayStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
    document.getElementById('content').innerHTML = '<div class="empty-state">Error loading data</div>';
  }
}

function showEmptyState() {
  document.getElementById('content').innerHTML = `
    <div class="empty-state">
      No recommendations captured yet.<br>
      Visit YouTube, Twitter, or LinkedIn to start tracking.
    </div>
  `;
}

function displayStats(stats) {
  const platformHTML = Object.entries(stats.byPlatform)
    .map(([platform, data]) => `
      <div class="platform-row">
        <span class="platform-name">${platform}</span>
        <span class="platform-count">${data.captures} visits • ${data.recommendations} items</span>
      </div>
    `)
    .join('');

  const oldestDate = stats.oldestCapture ? new Date(stats.oldestCapture).toLocaleDateString() : 'N/A';
  const newestDate = stats.newestCapture ? new Date(stats.newestCapture).toLocaleDateString() : 'N/A';

  document.getElementById('content').innerHTML = `
    <div class="stats">
      <div class="stat-row">
        <span class="stat-label">Total Visits</span>
        <span class="stat-value">${stats.totalCaptures}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Total Items Tracked</span>
        <span class="stat-value">${stats.totalRecommendations}</span>
      </div>

      <div class="platform-stats">
        ${platformHTML}
      </div>

      <div class="dates">
        First: ${oldestDate} • Latest: ${newestDate}
      </div>
    </div>

    <div class="actions">
      <button class="primary-btn" id="exportBtn">Export Data</button>
      <button class="secondary-btn" id="viewBtn">View Raw</button>
    </div>

    <div class="actions" style="margin-top: 8px;">
      <button class="danger-btn" id="clearBtn">Clear All Data</button>
    </div>
  `;

  // Attach event listeners
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('viewBtn').addEventListener('click', viewRawData);
  document.getElementById('clearBtn').addEventListener('click', clearData);
}

async function exportData() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY] || [];

    // Create formatted text export for LLM consumption
    let exportText = `Feed Recommendations Export\n`;
    exportText += `Generated: ${new Date().toISOString()}\n`;
    exportText += `Total Captures: ${data.length}\n`;
    exportText += `\n${'='.repeat(80)}\n\n`;

    data.forEach((entry, index) => {
      exportText += `[${index + 1}] ${entry.platform.toUpperCase()} - ${entry.date}\n`;
      exportText += `URL: ${entry.url}\n`;
      exportText += `Recommendations (${entry.count}):\n\n`;

      entry.recommendations.forEach((rec, recIndex) => {
        exportText += `  ${recIndex + 1}. ${rec.title}\n`;
        if (rec.channel || rec.author) {
          exportText += `     By: ${rec.channel || rec.author}\n`;
        }
        if (rec.url) {
          exportText += `     URL: ${rec.url}\n`;
        }
        exportText += `\n`;
      });

      exportText += `${'-'.repeat(80)}\n\n`;
    });

    // Download as text file
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `feed-recommendations-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    // Also copy to clipboard
    await navigator.clipboard.writeText(exportText);

    // Show feedback
    const btn = document.getElementById('exportBtn');
    const originalText = btn.textContent;
    btn.textContent = '✓ Exported & Copied';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error('Failed to export:', error);
    alert('Export failed. Check console for details.');
  }
}

async function viewRawData() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY] || [];

    // Download as JSON
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `feed-recommendations-raw-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    // Show feedback
    const btn = document.getElementById('viewBtn');
    const originalText = btn.textContent;
    btn.textContent = '✓ Downloaded';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error('Failed to view raw data:', error);
    alert('Download failed. Check console for details.');
  }
}

async function clearData() {
  if (!confirm('Are you sure you want to clear all tracked data? This cannot be undone.')) {
    return;
  }

  try {
    await chrome.storage.local.remove(STORAGE_KEY);
    loadStats(); // Reload to show empty state
  } catch (error) {
    console.error('Failed to clear data:', error);
    alert('Clear failed. Check console for details.');
  }
}

// Load stats on popup open
loadStats();
