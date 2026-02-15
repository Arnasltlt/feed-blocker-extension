document.addEventListener('DOMContentLoaded', () => {
  const feedGrid = document.getElementById('feed-grid');
  const emptyState = document.getElementById('empty-state');
  const clearBtn = document.getElementById('clear-history-btn');
  const loadMockBtn = document.getElementById('load-mock-btn');
  const summarizeBtn = document.getElementById('summarize-btn');
  const summarySection = document.getElementById('summary-section');
  const summaryTopics = document.getElementById('summary-topics');

  const STORAGE_KEY = 'feed_recommendations';
  const SUMMARIZE_API = 'https://feed-blocking-server.fly.dev/summarize';

  // Load data on start
  loadRecommendations();

  // Event Listeners
  clearBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear your feed history?')) {
      await chrome.storage.local.remove(STORAGE_KEY);
      loadRecommendations();
      summarySection.classList.add('hidden');
    }
  });

  loadMockBtn.addEventListener('click', () => {
    generateMockData();
  });

  summarizeBtn.addEventListener('click', async () => {
    await generateSummary();
  });

  async function loadRecommendations() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY] || [];

      renderFeed(data);
    } catch (err) {
      console.error('Failed to load recommendations:', err);
    }
  }

  function renderFeed(data) {
    feedGrid.innerHTML = '';
    
    if (!data || data.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    // Group by platform (reverse chronological to show newest sessions first)
    // We can also just show sessions as they are
    
    // Let's group by platform for a cleaner look, or just list sessions?
    // User asked for "accumulated feed". Let's show by platform but aggregated.
    
    const platforms = ['youtube', 'linkedin', 'twitter'];
    const groupedData = {};

    platforms.forEach(p => groupedData[p] = []);

    // Flatten data into platforms, respecting recency
    // The data structure is array of { platform, recommendations: [], timestamp }
    // We want to merge them but keep maybe the top N items or just all of them unique by URL
    
    const seenUrls = new Set();
    
    // Traverse backwards to get newest first
    [...data].reverse().forEach(entry => {
      const platform = entry.platform ? entry.platform.toLowerCase() : 'other';
      if (!groupedData[platform]) groupedData[platform] = [];

      if (entry.recommendations && Array.isArray(entry.recommendations)) {
        entry.recommendations.forEach(rec => {
          if (!seenUrls.has(rec.url)) {
            seenUrls.add(rec.url);
            groupedData[platform].push({
              ...rec,
              capturedAt: entry.timestamp
            });
          }
        });
      }
    });

    // Render each platform section
    Object.keys(groupedData).forEach(platform => {
      const items = groupedData[platform];
      if (items.length > 0) {
        const section = createPlatformSection(platform, items);
        feedGrid.appendChild(section);
      }
    });

    if (feedGrid.children.length === 0) {
       emptyState.classList.remove('hidden');
    }
  }

  function createPlatformSection(platformName, items) {
    const section = document.createElement('div');
    section.className = 'platform-section';

    const header = document.createElement('div');
    header.className = 'platform-header';
    header.innerHTML = `
      <h2>${capitalize(platformName)}</h2>
      <span class="platform-badge">${items.length} items</span>
    `;

    const row = document.createElement('div');
    row.className = 'recommendations-row';

    items.forEach(item => {
      const card = createCard(item);
      row.appendChild(card);
    });

    section.appendChild(header);
    section.appendChild(row);
    return section;
  }

  function createCard(item) {
    const card = document.createElement('div');
    card.className = 'card';

    const title = item.title || 'Untitled';
    const url = item.url || '#';
    const channel = item.channel || item.author || '';

    card.innerHTML = `
      <div class="card-content">
        <a href="${url}" target="_blank" class="card-title">${title}</a>
        <div class="card-meta">
          <span>${channel}</span>
        </div>
      </div>
      <a href="${url}" target="_blank" class="card-link">Visit Link &rarr;</a>
    `;

    return card;
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  async function generateMockData() {
    const mock = [
      {
        platform: 'youtube',
        timestamp: Date.now(),
        count: 2,
        recommendations: [
          { title: 'The Future of AI Agents', url: 'https://youtube.com/watch?v=123', channel: 'Tech Daily' },
          { title: 'Understanding Neural Networks', url: 'https://youtube.com/watch?v=456', channel: 'DeepMind' }
        ]
      },
      {
        platform: 'linkedin',
        timestamp: Date.now(),
        count: 1,
        recommendations: [
          { title: 'Why I left Big Tech', url: 'https://linkedin.com/post/789', channel: 'John Doe' }
        ]
      }
    ];

    await chrome.storage.local.set({ [STORAGE_KEY]: mock });
    loadRecommendations();
  }

  async function generateSummary() {
    try {
      // Get feed data
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY] || [];

      if (!data || data.length === 0) {
        showSummaryError('No feed data available. Visit some sites first!');
        return;
      }

      // Flatten all items from all platforms
      const items = flattenFeedItems(data);

      if (items.length === 0) {
        showSummaryError('No items found to summarize.');
        return;
      }

      // Show loading state
      summarizeBtn.disabled = true;
      summarizeBtn.textContent = 'Summarizing...';
      summaryTopics.innerHTML = '<div class="summary-loading">Analyzing your feed...</div>';
      summarySection.classList.remove('hidden');

      // Call API
      const response = await fetch(SUMMARIZE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const apiResult = await response.json();

      // Check for rate limit message
      if (apiResult.message) {
        showSummaryError(apiResult.message);
        return;
      }

      const topics = apiResult.topics || [];

      if (topics.length === 0) {
        showSummaryError('No topics found. Try visiting more sites to build your feed.');
        return;
      }

      // Render topics
      renderTopics(topics);

    } catch (err) {
      console.error('Failed to generate summary:', err);
      showSummaryError('Failed to generate summary. Check your connection and try again.');
    } finally {
      // Restore button state
      summarizeBtn.disabled = false;
      summarizeBtn.textContent = 'Summarize My Feed';
    }
  }

  function flattenFeedItems(data) {
    const items = [];
    const seenTitles = new Set();

    // Process newest first
    [...data].reverse().forEach(entry => {
      const platform = entry.platform || 'unknown';
      
      if (entry.recommendations && Array.isArray(entry.recommendations)) {
        entry.recommendations.forEach(rec => {
          const title = rec.title || '';
          if (title && !seenTitles.has(title)) {
            seenTitles.add(title);
            items.push({
              title: title,
              platform: platform,
              channel: rec.channel,
              author: rec.author
            });
          }
        });
      }
    });

    return items;
  }

  function renderTopics(topics) {
    summaryTopics.innerHTML = '';
    
    topics.forEach(topic => {
      const topicCard = document.createElement('div');
      topicCard.className = 'summary-topic';
      
      const title = document.createElement('h3');
      title.className = 'topic-title';
      title.textContent = topic.title;
      
      const summary = document.createElement('p');
      summary.className = 'topic-summary';
      summary.textContent = topic.summary;
      
      topicCard.appendChild(title);
      topicCard.appendChild(summary);

      if (topic.citations && topic.citations.length > 0) {
        const citationsEl = document.createElement('div');
        citationsEl.className = 'topic-citations';
        topic.citations.forEach(cit => {
          const blockquote = document.createElement('blockquote');
          blockquote.className = 'citation-quote';
          blockquote.textContent = `"${cit.quote}"`;
          const attr = document.createElement('cite');
          attr.className = 'citation-attribution';
          attr.textContent = `— ${cit.attribution}`;
          citationsEl.appendChild(blockquote);
          citationsEl.appendChild(attr);
        });
        topicCard.appendChild(citationsEl);
      }

      summaryTopics.appendChild(topicCard);
    });

    summarySection.classList.remove('hidden');
  }

  function showSummaryError(message) {
    summaryTopics.innerHTML = `<div class="summary-error">${message}</div>`;
    summarySection.classList.remove('hidden');
  }
});
