// TweetSave Content Script — Auto-scroll bookmark capture

let isCapturing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startAutoCapture') {
    startAutoCapture(message.existingUrls || [], sendResponse);
    return true; // Keep channel open for async response
  }
  if (message.action === 'stopCapture') {
    isCapturing = false;
    sendResponse({ stopped: true });
  }
});

// Extract tweet ID from URL — this is the unique identifier
function getTweetId(url) {
  if (!url) return null;
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function startAutoCapture(existingUrls, sendResponse) {
  isCapturing = true;

  // Build set of existing tweet IDs for reliable deduplication
  const existingIds = new Set();
  existingUrls.forEach(url => {
    const id = getTweetId(url);
    if (id) existingIds.add(id);
  });
  const allPosts = new Map(); // tweetId -> post data
  let lastCount = 0;
  let noNewCount = 0;

  while (isCapturing) {
    document.querySelectorAll('article').forEach(article => {
      try {
        const authorEl = article.querySelector('[data-testid="User-Name"]');
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const linkEl = article.querySelector('a[href*="/status/"]');
        const author = authorEl ? authorEl.innerText.split('\n')[0].trim() : 'Unknown';
        const text = textEl ? textEl.innerText.trim().substring(0, 500) : '';
        const url = linkEl ? 'https://x.com' + linkEl.getAttribute('href') : '';
        const tweetId = getTweetId(url);
        const key = tweetId || text;
        if (key && !allPosts.has(key)) {
          allPosts.set(key, { author, text, url, tweetId });
        }
      } catch(e) {}
    });

    const total = allPosts.size;
    const newCount = [...allPosts.values()].filter(p =>
      p.tweetId ? !existingIds.has(p.tweetId) : true
    ).length;

    chrome.runtime.sendMessage({ action: 'captureProgress', total, newCount });

    if (total === lastCount) {
      noNewCount++;
      if (noNewCount >= 3) break;
    } else {
      noNewCount = 0;
      lastCount = total;
    }

    window.scrollBy(0, 800);
    await new Promise(r => setTimeout(r, 1500));
  }

  const newPosts = [...allPosts.values()].filter(p =>
    p.tweetId ? !existingIds.has(p.tweetId) : true
  );
  sendResponse({ posts: newPosts, total: allPosts.size });
}
