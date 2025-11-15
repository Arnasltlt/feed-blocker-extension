/* eslint-disable no-console */
const RERANK_MESSAGE_TYPE = 'RERANK_VIDEOS';
const RERANK_ENDPOINTS = [
  'http://127.0.0.1:11400/rerank',
  'http://localhost:11400/rerank'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== RERANK_MESSAGE_TYPE) {
    return false;
  }

  handleRerankRequest(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});

async function handleRerankRequest(payload) {
  if (!payload || !Array.isArray(payload.videos) || payload.videos.length === 0) {
    return { videos: [] };
  }

  const body = JSON.stringify(payload);
  let lastError = null;

  for (const endpoint of RERANK_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} when calling ${endpoint}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      console.warn('[feed-blocker] Failed to reach custom feed server:', endpoint, error);
    }
  }

  throw lastError || new Error('Unable to reach local Groq server at http://127.0.0.1:11400/rerank');
}

