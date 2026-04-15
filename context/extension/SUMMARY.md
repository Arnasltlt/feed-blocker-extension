# Extension (`extension/`)

Implementation lives in the repo at [`extension/`](../../extension/). This file routes only.

| File | Role |
|------|------|
| [`manifest.json`](../../extension/manifest.json) | MV3 manifest: service worker, permissions, host access, DNR rules, content script matches |
| [`background.js`](../../extension/background.js) | Service worker: e.g. `OPEN_FEED_PAGE`, `RERANK_VIDEOS` proxy to local/Fly `/rerank` |
| [`recommendation-tracker.js`](../../extension/recommendation-tracker.js) | Captures slim recommendation items into `chrome.storage.local` |
| [`local-ai.js`](../../extension/local-ai.js) | Optional Chrome Prompt API path for grouping when available (YouTube flow) |
| [`youtube-home-blocker.js`](../../extension/youtube-home-blocker.js) | YouTube home: hide feed, rerank/grouped UI or fallback, Shorts handling |
| [`linkedin-feed-blocker.js`](../../extension/linkedin-feed-blocker.js) | LinkedIn: hide feed/notifications, inject Focus Feed brief |
| [`x-feed-blocker.js`](../../extension/x-feed-blocker.js) | X/Twitter: hide timeline/sidebar, tracker + brief + `/summarize` |
| [`fb-messages-block-rules.json`](../../extension/fb-messages-block-rules.json) | Declarative Net Request rules for Facebook Messages |
| [`facebook-messages-header-blocker.css`](../../extension/facebook-messages-header-blocker.css) | Styles for Facebook `/messages` chrome hiding |
| [`facebook-messages-header-blocker.js`](../../extension/facebook-messages-header-blocker.js) | Facebook `/messages`: hide nav/chrome elements |
| [`popup.html`](../../extension/popup.html) | Toolbar popup shell for Focus Feed |
| [`popup.js`](../../extension/popup.js) | Renders cached brief and opens full feed / research links |
| [`feed.html`](../../extension/feed.html) | Full-page Focus Feed UI |
| [`feed.js`](../../extension/feed.js) | Full feed: storage, `/summarize`, mocks, fallbacks |
| [`feed.css`](../../extension/feed.css) | Full feed page styles |
| [`LOAD_THIS_FOLDER_IN_CHROME.txt`](../../extension/LOAD_THIS_FOLDER_IN_CHROME.txt) | Reminder to load this folder only in Chrome |
