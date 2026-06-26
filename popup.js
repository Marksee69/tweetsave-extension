// TweetSave v2.3

const SUPABASE_URL = 'https://mkpctqblkpwwxwbyaref.supabase.co';
const SUPABASE_KEY = 'sb_publishable_9iFs1ty98zGygTJx9m7Xig_rWqCCDh1';
const STRIPE_PRICE_ID = 'price_1TmJVbRy4ryTcUrSLEEYbTDx';
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/14A9AVboYd1r1cC3NgbZe00';

const DEFAULT_CATEGORIES = ['Uncategorized', 'AI', 'Learning', 'Music & Guitar', 'Health', 'Politics', 'Personal Interest', 'Other'];
const PROTECTED_CATEGORIES = ['Uncategorized'];
let bookmarks = [];
let categories = [...DEFAULT_CATEGORIES];
let activeFilter = 'All';
let isAutoCapturing = false;
let currentUser = null;
let autoCaptureEnabled = true;

const AVATAR_COLORS = ['#1d9bf0','#00ba7c','#ff7a00','#f91880','#7856ff','#ff6b6b','#00b8d9'];

function getInitials(name) {
  return name ? name.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase() : '?';
}

function getCatColor(cat) {
  const colors = {
    'AI': '#1d9bf0', 'Learning': '#00ba7c', 'Music & Guitar': '#7856ff',
    'Health': '#00b8d9', 'Politics': '#ff6b6b', 'Personal Interest': '#ff7a00',
    'Claude': '#a855f7', 'Food': '#f9a825', 'Other': '#71767b', 'Uncategorized': '#536471'
  };
  if (colors[cat]) return colors[cat];
  const palette = ['#e040fb','#00bcd4','#ff5722','#8bc34a','#ffc107','#009688','#3f51b5'];
  let hash = 0;
  for (let c of (cat||'')) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

async function supabaseRequest(endpoint, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(`${SUPABASE_URL}${endpoint}`, options);
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function signUp(email, password) {
  const data = await supabaseRequest('/auth/v1/signup', 'POST', { email, password });
  if (data.error) throw new Error(data.error.message || 'Signup failed');
  return data;
}

async function signIn(email, password) {
  const data = await supabaseRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
  if (data.error) throw new Error(data.error.message || 'Login failed');
  return data;
}

async function signOut(token) {
  await supabaseRequest('/auth/v1/logout', 'POST', {}, token);
}

function saveSession(session) {
  chrome.storage.local.set({ supabase_token: session.access_token, supabase_user: session.user });
  currentUser = session.user;
  categoryIdCache = {};
  updateAuthUI();
}

function clearSession() {
  chrome.storage.local.remove(['supabase_token', 'supabase_user']);
  currentUser = null;
  categoryIdCache = {};
  updateAuthUI();
}
// ── CLOUD SYNC ────────────────────────────────────────────────────────────

let categoryIdCache = {};

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getToken() {
  return new Promise(resolve => {
    chrome.storage.local.get(['supabase_token'], result => resolve(result.supabase_token || null));
  });
}

async function ensureUserProfile(token) {
  if (!currentUser) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'resolution=ignore-duplicates'
      },
      body: JSON.stringify({ id: currentUser.id, email: currentUser.email })
    });
  } catch (e) {
    console.error('Failed to create user profile', e);
  }
}

async function getOrCreateCategoryId(name, token) {
  if (categoryIdCache[name]) return categoryIdCache[name];
  const existing = await supabaseRequest(`/rest/v1/categories?name=eq.${encodeURIComponent(name)}&select=id`, 'GET', null, token);
  if (Array.isArray(existing) && existing.length > 0) {
    categoryIdCache[name] = existing[0].id;
    return existing[0].id;
  }
  const newId = generateUUID();
  await supabaseRequest('/rest/v1/categories', 'POST', { id: newId, user_id: currentUser.id, name: name }, token);
  categoryIdCache[name] = newId;
  return newId;
}

async function pushBookmarkToSupabase(bookmark, token) {
  try {
    const categoryId = await getOrCreateCategoryId(bookmark.category || 'Uncategorized', token);
    const supabaseId = bookmark.supabaseId || generateUUID();
    const payload = {
      id: supabaseId,
      user_id: currentUser.id,
      category_id: categoryId,
      author_name: bookmark.author || 'Unknown',
      author_handle: '',
      content: bookmark.text || '',
      url: bookmark.url || '',
      saved_at: new Date(bookmark.savedAt).toISOString()
    };
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/bookmarks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(payload)
    });
    const respText = await resp.text();
    if (!resp.ok) {
      console.error(`Push failed for ${bookmark.id}: ${resp.status} ${respText}`);
      return;
    }
    if (!respText || respText === '[]') {
      console.warn(`Push for ${bookmark.id} returned OK but inserted nothing — RLS may be silently blocking`);
      return;
    }
    bookmark.supabaseId = supabaseId;
    bookmark.dirty = false;
  } catch (e) {
    console.error('Sync push failed for bookmark', bookmark.id, e);
  }
}

async function deleteBookmarkFromCloud(supabaseId, token) {
  if (!supabaseId || !token) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/bookmarks?id=eq.${supabaseId}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${token}` }
    });
  } catch (e) {
    console.error('Cloud delete failed', e);
  }
}

async function syncAllBookmarksToCloud() {
  if (!currentUser) return;
  const token = await getToken();
  if (!token) return;
  const premiumCheck = await supabaseRequest(`/rest/v1/users?id=eq.${currentUser.id}&select=premium`, 'GET', null, token);
  const isPremium = Array.isArray(premiumCheck) && premiumCheck.length > 0 && premiumCheck[0].premium === true;
  if (!isPremium) {
    showSyncStatus('☁️ Upgrade to Pro to sync across devices', false);
    return;
  }
  await ensureUserProfile(token);
  const toSync = bookmarks.filter(b => b.dirty || !b.supabaseId);
  if (!toSync.length) return;
  let count = 0;
  showSyncStatus(`Syncing 0/${toSync.length} bookmarks...`, true);
  for (const b of toSync) {
    await pushBookmarkToSupabase(b, token);
    count++;
    if (count % 5 === 0 || count === toSync.length) {
      showSyncStatus(`Syncing ${count}/${toSync.length} bookmarks...`, true);
    }
  }
  chrome.storage.local.set({ bookmarks, categories });
  showSyncStatus(`Synced ${count} bookmarks to cloud!`, false);
}

async function pullBookmarksFromCloud() {
  if (!currentUser) return;
  const token = await getToken();
  if (!token) return;
  try {
    const cloudCategories = await supabaseRequest('/rest/v1/categories?select=id,name', 'GET', null, token);
    const catIdToName = {};
    if (Array.isArray(cloudCategories)) {
      cloudCategories.forEach(c => {
        catIdToName[c.id] = c.name;
        categoryIdCache[c.name] = c.id;
        if (!categories.includes(c.name)) categories.push(c.name);
      });
    }
    const cloudBookmarks = await supabaseRequest('/rest/v1/bookmarks?select=*', 'GET', null, token);
    if (!Array.isArray(cloudBookmarks)) return;
    const localBySupabaseId = {};
    bookmarks.forEach(b => { if (b.supabaseId) localBySupabaseId[b.supabaseId] = b; });
    let added = 0;
    cloudBookmarks.forEach(cb => {
      if (localBySupabaseId[cb.id]) return;
      bookmarks.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
        supabaseId: cb.id,
        author: cb.author_name || 'Unknown',
        text: cb.content || '',
        url: cb.url || '',
        category: catIdToName[cb.category_id] || 'Uncategorized',
        savedAt: new Date(cb.saved_at).getTime()
      });
      added++;
    });
    chrome.storage.local.set({ bookmarks, categories });
    updateUI();
    if (added > 0) showToast(`☁️ Synced ${added} bookmark(s) from another device`);
  } catch (e) {
    console.error('Sync pull failed', e);
  }
}

function loadSession() {
  chrome.storage.local.get(['supabase_token', 'supabase_user'], (result) => {
    if (result.supabase_user) { currentUser = result.supabase_user; updateAuthUI(); pullBookmarksFromCloud().then(syncAllBookmarksToCloud); }
  });
}

function updateAuthUI() {
  const authBtn = document.getElementById('authHeaderBtn');
  const userBar = document.getElementById('userBar');
  const userEmail = document.getElementById('userEmail');
  const upgradeBanner = document.getElementById('upgradeBanner');
  const upgradeBtn = document.getElementById('upgradeBtn');
  if (currentUser) {
    if (authBtn) { authBtn.textContent = '✓ Signed in'; authBtn.className = 'auth-btn-small logged-in'; }
    if (userBar) userBar.style.display = 'flex';
    if (userEmail) userEmail.textContent = '📧 ' + currentUser.email;
    checkPremiumStatus();
  } else {
    if (authBtn) { authBtn.textContent = 'Sign in'; authBtn.className = 'auth-btn-small'; }
    if (userBar) userBar.style.display = 'none';
    if (upgradeBanner) {
      upgradeBanner.style.display = 'flex';
      upgradeBanner.querySelector('.upgrade-text').innerHTML = '☁️ <strong>Sync across devices</strong> — upgrade to Pro';
      if (upgradeBtn) { upgradeBtn.textContent = 'Sign in free'; upgradeBtn.onclick = () => showAuthModal('signup'); }
    }
  }
}

async function checkPremiumStatus() {
  const upgradeBanner = document.getElementById('upgradeBanner');
  const upgradeBtn = document.getElementById('upgradeBtn');
  if (!currentUser) return;
  const token = await getToken();
  const result = await supabaseRequest(`/rest/v1/users?id=eq.${currentUser.id}&select=premium`, 'GET', null, token);
  const isPremium = Array.isArray(result) && result.length > 0 && result[0].premium === true;
  if (isPremium) {
    if (upgradeBanner) upgradeBanner.style.display = 'none';
  } else {
    if (upgradeBanner) {
      upgradeBanner.style.display = 'flex';
      upgradeBanner.querySelector('.upgrade-text').innerHTML = '☁️ <strong>Upgrade to Pro</strong> — sync across devices';
      if (upgradeBtn) { upgradeBtn.textContent = 'Upgrade $3.99/mo'; upgradeBtn.onclick = () => chrome.tabs.create({ url: STRIPE_PAYMENT_LINK }); }
    }
  }
}

function showAuthModal(mode = 'signin') {
  document.querySelectorAll('.auth-modal-overlay').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'auth-modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1e2732;border-radius:16px;padding:24px;width:340px;border:1px solid #2f3336;';
  let isSignUp = mode === 'signup';

  function renderModal() {
    modal.innerHTML = '';
    const headerDiv = document.createElement('div');
    headerDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    const title = document.createElement('h2');
    title.style.cssText = 'font-size:18px;font-weight:700;color:#e7e9ea;';
    title.textContent = isSignUp ? '🔖 Create account' : '🔖 Sign in';
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#71767b;cursor:pointer;font-size:18px;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    headerDiv.appendChild(title);
    headerDiv.appendChild(closeBtn);
    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'font-size:13px;color:#71767b;margin-bottom:20px;line-height:1.5;';
    subtitle.textContent = isSignUp ? 'Create a free account to unlock cloud sync across devices.' : 'Sign in to your TweetSave account.';
    const errorEl = document.createElement('div');
    errorEl.style.cssText = 'display:none;font-size:12px;color:#f4212e;margin-bottom:10px;text-align:center;';
    const successEl = document.createElement('div');
    successEl.style.cssText = 'display:none;font-size:12px;color:#00ba7c;margin-bottom:10px;text-align:center;';
    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'Email address';
    emailInput.style.cssText = 'width:100%;padding:12px 16px;background:#202327;border:1px solid #2f3336;border-radius:12px;font-size:14px;color:#e7e9ea;outline:none;margin-bottom:12px;';
    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.placeholder = 'Password (min 6 characters)';
    passwordInput.style.cssText = 'width:100%;padding:12px 16px;background:#202327;border:1px solid #2f3336;border-radius:12px;font-size:14px;color:#e7e9ea;outline:none;margin-bottom:12px;';
    const submitBtn = document.createElement('button');
    submitBtn.style.cssText = 'width:100%;padding:12px;background:#1d9bf0;color:white;border:none;border-radius:20px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:12px;';
    submitBtn.textContent = isSignUp ? 'Create account' : 'Sign in';
    const toggleDiv = document.createElement('div');
    toggleDiv.style.cssText = 'text-align:center;font-size:13px;color:#71767b;';
    const toggleText = document.createTextNode(isSignUp ? 'Already have an account? ' : 'New to TweetSave? ');
    const toggleSpan = document.createElement('span');
    toggleSpan.style.cssText = 'color:#1d9bf0;cursor:pointer;font-weight:600;';
    toggleSpan.textContent = isSignUp ? 'Sign in' : 'Create account';
    toggleSpan.addEventListener('click', () => { isSignUp = !isSignUp; renderModal(); });
    toggleDiv.appendChild(toggleText);
    toggleDiv.appendChild(toggleSpan);
    submitBtn.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      errorEl.style.display = 'none';
      successEl.style.display = 'none';
      if (!email || !password) { errorEl.textContent = 'Please enter email and password'; errorEl.style.display = 'block'; return; }
      submitBtn.textContent = isSignUp ? 'Creating...' : 'Signing in...';
      submitBtn.disabled = true;
      try {
        if (isSignUp) {
          const session = await signUp(email, password);
          if (session.access_token) {
            saveSession(session);
            overlay.remove();
            showToast('✅ Account created and signed in!');
            await pullBookmarksFromCloud();
            syncAllBookmarksToCloud();
          } else {
            successEl.textContent = '✅ Account created! Please sign in.';
            successEl.style.display = 'block';
            setTimeout(() => { isSignUp = false; renderModal(); }, 2000);
          }
        } else {
          const session = await signIn(email, password);
          saveSession(session);
          overlay.remove();
          showToast('✅ Signed in successfully!');
          await pullBookmarksFromCloud();
          syncAllBookmarksToCloud();
        }
      } catch(err) {
        errorEl.textContent = err.message || 'Something went wrong. Please try again.';
        errorEl.style.display = 'block';
      }
      submitBtn.textContent = isSignUp ? 'Create account' : 'Sign in';
      submitBtn.disabled = false;
    });
    [emailInput, passwordInput].forEach(input => {
      input.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitBtn.click(); });
    });
    modal.appendChild(headerDiv);
    modal.appendChild(subtitle);
    modal.appendChild(errorEl);
    modal.appendChild(successEl);
    modal.appendChild(emailInput);
    modal.appendChild(passwordInput);
    modal.appendChild(submitBtn);
    modal.appendChild(toggleDiv);
  }

  renderModal();
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── HELP MODAL ────────────────────────────────────────────────────────────

function showHelpModal() {
  document.querySelectorAll('.help-modal-overlay').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'help-modal-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1e2732;border-radius:16px;padding:24px;width:340px;border:1px solid #2f3336;';
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="font-size:17px;font-weight:700;color:#e7e9ea;">🔖 How to use TweetSave</h2>
      <button id="helpCloseBtn" style="background:none;border:none;color:#71767b;cursor:pointer;font-size:18px;line-height:1;">✕</button>
    </div>
    <div style="font-size:13px;color:#71767b;line-height:1.8;">
      <p style="margin-bottom:12px;"><strong style="color:#e7e9ea;">1. Capture your bookmarks</strong><br>
        Go to <span style="color:#1d9bf0;">x.com/bookmarks</span> and open TweetSave — it auto-scans and saves new bookmarks to <em>Uncategorized</em>.</p>
      <p style="margin-bottom:12px;"><strong style="color:#e7e9ea;">2. Organize</strong><br>
        New bookmarks land in <em>Uncategorized</em>. Use the category dropdown on each card to sort them.</p>
      <p style="margin-bottom:12px;"><strong style="color:#e7e9ea;">3. Search</strong><br>
        Type anything in the search bar to find bookmarks instantly across all categories.</p>
      <p style="margin-bottom:12px;"><strong style="color:#e7e9ea;">4. Cloud sync (Pro)</strong><br>
        Sign in and upgrade to Pro ($3.99/mo) to access your bookmarks on any device.</p>
      <p><strong style="color:#e7e9ea;">5. Export & backup</strong><br>
        Use the Export tab to save your bookmarks as JSON, CSV, or HTML.</p>
    </div>
    <button id="helpGotItBtn" style="width:100%;margin-top:20px;padding:11px;background:#1d9bf0;color:white;border:none;border-radius:20px;font-size:14px;font-weight:700;cursor:pointer;">Got it!</button>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.getElementById('helpCloseBtn').addEventListener('click', () => overlay.remove());
  document.getElementById('helpGotItBtn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── AUTO-CAPTURE TOGGLE ───────────────────────────────────────────────────

function toggleAutoCapture(enabled) {
  autoCaptureEnabled = enabled;
  chrome.storage.local.set({ autoCaptureEnabled });
  const toggle = document.getElementById('autoCaptureToggle');
  if (toggle) toggle.checked = enabled;
}

// ── INIT ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadData(() => {
    loadSession();
  });
  setupEventListeners();
  checkCurrentTabAndAutoCapture();
});

function setupEventListeners() {
  document.getElementById('tabBookmarks').addEventListener('click', () => showTab('bookmarks', document.getElementById('tabBookmarks')));
  document.getElementById('tabCapture').addEventListener('click', () => { showTab('capture', document.getElementById('tabCapture')); checkCurrentTab(); });
  document.getElementById('tabExport').addEventListener('click', () => showTab('export', document.getElementById('tabExport')));
  document.getElementById('searchInput').addEventListener('input', renderBookmarks);
  document.getElementById('addCatBtn').addEventListener('click', addCategory);
  document.getElementById('newCatInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') addCategory(); });
  document.getElementById('captureBtn').addEventListener('click', capturePageBookmarks);
  document.getElementById('captureCurrentBtn').addEventListener('click', captureCurrentPost);
  document.getElementById('exportJSON').addEventListener('click', exportJSON);
  document.getElementById('exportCSV').addEventListener('click', exportCSV);
  document.getElementById('exportHTML').addEventListener('click', exportHTML);
  document.getElementById('importJSON').addEventListener('click', () => {
    const importFile = document.getElementById('importFile');
    importFile.value = '';
    importFile.click();
  });
  document.getElementById('importFile').addEventListener('change', handleImport);
  document.getElementById('clearAll').addEventListener('click', clearAllBookmarks);

  const authHeaderBtn = document.getElementById('authHeaderBtn');
  const upgradeBtn = document.getElementById('upgradeBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  const helpBtn = document.getElementById('helpBtn');
  const autoCaptureToggle = document.getElementById('autoCaptureToggle');

  if (authHeaderBtn) authHeaderBtn.addEventListener('click', () => { if (!currentUser) showAuthModal('signin'); });
  if (upgradeBtn) upgradeBtn.addEventListener('click', () => showAuthModal('signup'));
  if (signOutBtn) signOutBtn.addEventListener('click', async () => {
    chrome.storage.local.get(['supabase_token'], async (result) => {
      if (result.supabase_token) await signOut(result.supabase_token);
      clearSession();
      showToast('Signed out');
    });
  });
  if (helpBtn) helpBtn.addEventListener('click', showHelpModal);
  if (autoCaptureToggle) {
    autoCaptureToggle.checked = autoCaptureEnabled;
    autoCaptureToggle.addEventListener('change', (e) => toggleAutoCapture(e.target.checked));
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'captureProgress') updateCaptureProgress(message.total, message.newCount);
});

function checkCurrentTabAndAutoCapture() {
  if (!autoCaptureEnabled) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0] ? tabs[0].url : '';
    const isBookmarksPage = url.includes('x.com/i/bookmarks') || url.includes('twitter.com/i/bookmarks');
    if (isBookmarksPage && !isAutoCapturing) startAutoCapture(tabs[0].id);
  });
}

function checkCurrentTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0] ? tabs[0].url : '';
    const isX = url.includes('x.com') || url.includes('twitter.com');
    const statusEl = document.getElementById('siteStatus');
    const statusText = document.getElementById('statusText');
    if (statusEl && statusText) {
      statusText.textContent = isX ? 'Connected to X — ready to capture' : 'Navigate to x.com to enable capture';
      statusEl.className = 'status-bar ' + (isX ? 'onsite' : 'offsite');
    }
    document.getElementById('captureBtn').disabled = !isX;
    document.getElementById('captureCurrentBtn').disabled = !isX;
  });
}

function showCaptureStatus(message, isProgress) {
  let statusBar = document.getElementById('autoCaptureStatus');
  if (!statusBar) {
    statusBar = document.createElement('div');
    statusBar.id = 'autoCaptureStatus';
    statusBar.style.cssText = 'padding:10px 16px;background:#1d9bf020;border-bottom:1px solid #2f3336;font-size:13px;color:#1d9bf0;display:flex;align-items:center;gap:8px;';
    const statsRow = document.querySelector('.stats-row');
    if (statsRow) statsRow.after(statusBar);
  }
  statusBar.innerHTML = isProgress ? `<span>⟳</span> ${message}` : `✅ ${message}`;
  if (!isProgress) setTimeout(() => { if (statusBar) statusBar.remove(); }, 4000);
}

function showSyncStatus(message, isProgress) {
  let statusBar = document.getElementById('syncStatus');
  if (!statusBar) {
    statusBar = document.createElement('div');
    statusBar.id = 'syncStatus';
    statusBar.style.cssText = 'padding:10px 16px;background:#00ba7c20;border-bottom:1px solid #2f3336;font-size:13px;color:#00ba7c;display:flex;align-items:center;gap:8px;';
    const statsRow = document.querySelector('.stats-row');
    if (statsRow) statsRow.after(statusBar);
  }
  statusBar.innerHTML = isProgress ? `<span>☁️</span> ${message}` : `✅ ${message}`;
  if (!isProgress) setTimeout(() => { if (statusBar) statusBar.remove(); }, 4000);
}

function updateCaptureProgress(total, newCount) {
  showCaptureStatus(`Scanning... ${total} found, ${newCount} new`, true);
}

function startAutoCapture(tabId) {
  isAutoCapturing = true;
  const existingUrls = bookmarks.map(b => b.url).filter(Boolean);
  showCaptureStatus('Starting scan...', true);
  chrome.tabs.sendMessage(tabId, { action: 'startAutoCapture', existingUrls }, (response) => {
    isAutoCapturing = false;
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { action: 'startAutoCapture', existingUrls }, handleAutoCaptureResponse);
        }, 500);
      });
      return;
    }
    handleAutoCaptureResponse(response);
  });
}

function handleAutoCaptureResponse(response) {
  isAutoCapturing = false;
  if (!response || !response.posts) { showCaptureStatus('Scan complete — no new bookmarks found', false); return; }
  const newPosts = response.posts;
  if (!newPosts.length) { showCaptureStatus(`Scan complete — all ${response.total} bookmarks already saved!`, false); return; }
  // Auto-save to Uncategorized — no dialog needed
  saveCaptured(newPosts, 'Uncategorized');
  showCaptureStatus(`Saved ${newPosts.length} new bookmarks to Uncategorized`, false);
}

function loadData(callback) {
  chrome.storage.local.get(['bookmarks', 'categories', 'autoCaptureEnabled'], (result) => {
    bookmarks = result.bookmarks || [];
    categories = result.categories || [...DEFAULT_CATEGORIES];
    autoCaptureEnabled = result.autoCaptureEnabled !== false; // default true
    // Ensure Uncategorized always exists
    if (!categories.includes('Uncategorized')) categories.unshift('Uncategorized');
    updateUI();
    if (callback) callback();
  });
}

function saveData() {
  chrome.storage.local.set({ bookmarks, categories });
  if (currentUser) syncAllBookmarksToCloud();
}

function updateUI() {
  updateStats();
  renderFilters();
  renderBookmarks();
  document.getElementById('totalCount').textContent = bookmarks.length + ' saved';
  // Sync toggle state
  const toggle = document.getElementById('autoCaptureToggle');
  if (toggle) toggle.checked = autoCaptureEnabled;
}

function updateStats() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  document.getElementById('statTotal').textContent = bookmarks.length;
  document.getElementById('statCategories').textContent = categories.length;
  document.getElementById('statToday').textContent = bookmarks.filter(b => b.savedAt > weekAgo).length;
}

function renderFilters() {
  const row = document.getElementById('filterRow');
  if (!row) return;
  row.innerHTML = '';
  ['All', ...categories].forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn' + (activeFilter === cat ? ' active' : '');
    btn.textContent = cat + (cat !== 'All' ? ' ' + bookmarks.filter(b => b.category === cat).length : '');
    btn.addEventListener('click', () => { activeFilter = cat; renderFilters(); renderBookmarks(); });
    row.appendChild(btn);
  });
}

function renderBookmarks() {
  const list = document.getElementById('bookmarksList');
  if (!list) return;
  const search = (document.getElementById('searchInput').value || '').toLowerCase();
  let filtered = bookmarks.filter(b => {
    const matchFilter = activeFilter === 'All' || b.category === activeFilter;
    const matchSearch = !search || (b.author||'').toLowerCase().includes(search) || (b.text||'').toLowerCase().includes(search) || (b.category||'').toLowerCase().includes(search);
    return matchFilter && matchSearch;
  }).sort((a, b) => b.savedAt - a.savedAt);
  list.innerHTML = '';
  // Show AI teaser banner when viewing Uncategorized
  let aiBanner = document.getElementById('aiBanner');
  if (aiBanner) aiBanner.remove();
  if (activeFilter === 'Uncategorized') {
    aiBanner = document.createElement('div');
    aiBanner.id = 'aiBanner';
    aiBanner.style.cssText = 'padding:10px 16px;background:#7856ff15;border-bottom:1px solid #7856ff30;font-size:12px;color:#7856ff;display:flex;align-items:center;gap:8px;';
    aiBanner.innerHTML = '🤖 <span><strong>AI auto-categorization coming soon</strong> — it will sort these for you automatically.</span>';
    list.before(aiBanner);
  }

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<div class="icon">📌</div><p>' + (bookmarks.length === 0 ? 'No bookmarks yet.<br>Go to x.com/bookmarks to auto-capture!' : 'No results match your search.') + '</p>';
    list.appendChild(empty);
    return;
  }
  filtered.forEach(b => {
    const card = document.createElement('div');
    card.className = 'bookmark-card';
    const avatarColor = getCatColor(b.category);
    const initials = getInitials(b.author);
    const date = new Date(b.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const cardTop = document.createElement('div');
    cardTop.className = 'card-top';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = avatarColor;
    avatar.textContent = initials;
    const content = document.createElement('div');
    content.className = 'card-content';
    const header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML = `<span class="author-name">${b.author||'Unknown'}</span><span class="card-date">${date}</span>`;
    const textEl = document.createElement('div');
    textEl.className = 'card-text truncated';
    textEl.textContent = (b.text||'').trim();
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const leftActions = document.createElement('div');
    leftActions.className = 'card-left';
    const select = document.createElement('select');
    select.className = 'cat-select';
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c; opt.textContent = c; opt.selected = b.category === c;
      select.appendChild(opt);
    });
    select.addEventListener('change', (e) => { e.stopPropagation(); b.category = select.value; b.dirty = true; saveData(); renderFilters(); renderBookmarks(); showToast('Moved to ' + select.value); });
    leftActions.appendChild(select);
    const rightActions = document.createElement('div');
    rightActions.className = 'card-right';
    if (b.url) {
      const viewBtn = document.createElement('button');
      viewBtn.className = 'action-btn';
      viewBtn.innerHTML = '𝕏 View';
      viewBtn.addEventListener('click', (e) => { e.stopPropagation(); chrome.tabs.create({ url: b.url }); });
      rightActions.appendChild(viewBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'action-btn danger';
    delBtn.innerHTML = '🗑️ Del';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (currentUser && b.supabaseId) { const token = await getToken(); deleteBookmarkFromCloud(b.supabaseId, token); }
      bookmarks = bookmarks.filter(x => x.id !== b.id);
      saveData(); updateUI(); showToast('Deleted');
    });
    rightActions.appendChild(delBtn);
    actions.appendChild(leftActions);
    actions.appendChild(rightActions);
    content.appendChild(header);
    content.appendChild(textEl);
    content.appendChild(actions);
    cardTop.appendChild(avatar);
    cardTop.appendChild(content);
    card.appendChild(cardTop);
    list.appendChild(card);
  });
}

function addCategory() {
  const input = document.getElementById('newCatInput');
  const name = input.value.trim();
  if (!name) return;
  if (PROTECTED_CATEGORIES.includes(name)) { showToast('That category is protected!'); return; }
  if (categories.includes(name)) { showToast('Already exists!'); return; }
  categories.push(name);
  saveData();
  input.value = '';
  renderFilters();
  showToast('"' + name + '" added!');
}

function showTab(tabName, btn) {
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
  document.getElementById('tab-' + tabName).style.display = 'block';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function capturePageBookmarks() {
  showToast('Scanning page...');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const posts = []; const seen = new Set();
        document.querySelectorAll('article').forEach(article => {
          try {
            const authorEl = article.querySelector('[data-testid="User-Name"]');
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const linkEl = article.querySelector('a[href*="/status/"]');
            const author = authorEl ? authorEl.innerText.split('\n')[0].trim() : 'Unknown';
            const text = textEl ? textEl.innerText.trim().substring(0, 500) : '';
            const url = linkEl ? 'https://x.com' + linkEl.getAttribute('href') : '';
            const key = url || text;
            if (key && !seen.has(key)) { seen.add(key); posts.push({ author, text, url }); }
          } catch(e) {}
        });
        return posts;
      }
    }, (results) => {
      if (chrome.runtime.lastError) { showToast('Error: ' + chrome.runtime.lastError.message); return; }
      const posts = results && results[0] && results[0].result;
      if (!posts || !posts.length) { showToast('No posts found. Scroll to load more!'); return; }
      showCategoryDialog(posts);
    });
  });
}

function captureCurrentPost() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const a = document.querySelector('[data-testid="User-Name"]');
        const t = document.querySelector('[data-testid="tweetText"]');
        return { author: a ? a.innerText.split('\n')[0].trim() : 'Unknown', text: t ? t.innerText.trim().substring(0, 500) : '', url: window.location.href };
      }
    }, (results) => { if (results && results[0]) showCategoryDialog([results[0].result]); });
  });
}

function showCategoryDialog(posts) {
  document.querySelectorAll('.cat-dialog').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'cat-dialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1e2732;border-radius:16px;padding:20px;width:340px;border:1px solid #2f3336;';
  const title = document.createElement('h3');
  title.style.cssText = 'font-size:16px;margin-bottom:6px;color:#e7e9ea;font-weight:700;';
  title.textContent = '📌 Save ' + posts.length + ' new bookmark(s)';
  const subtitle = document.createElement('p');
  subtitle.style.cssText = 'font-size:13px;color:#71767b;margin-bottom:14px;';
  subtitle.textContent = 'Choose a category:';
  const btnWrap = document.createElement('div');
  btnWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;';
  categories.forEach(c => {
    const btn = document.createElement('button');
    const color = getCatColor(c);
    btn.style.cssText = `padding:8px 16px;border-radius:20px;border:1px solid ${color};background:transparent;cursor:pointer;font-size:13px;font-weight:600;color:${color};`;
    btn.textContent = c;
    btn.addEventListener('mouseover', () => { btn.style.background = color + '20'; });
    btn.addEventListener('mouseout', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', () => { saveCaptured(posts, c); overlay.remove(); });
    btnWrap.appendChild(btn);
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'width:100%;padding:10px;border:1px solid #2f3336;border-radius:20px;background:transparent;cursor:pointer;font-size:14px;color:#71767b;font-weight:500;';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());
  dialog.appendChild(title); dialog.appendChild(subtitle); dialog.appendChild(btnWrap); dialog.appendChild(cancelBtn);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

function saveCaptured(posts, category) {
  let added = 0;
  posts.forEach(post => {
    if (!bookmarks.some(b => b.url === post.url || (b.text === post.text && post.text))) {
      bookmarks.push({ id: Date.now().toString(36) + Math.random().toString(36).substr(2,9), author: post.author, text: post.text, url: post.url, category, savedAt: Date.now(), dirty: true });
      added++;
    }
  });
  saveData(); updateUI();
  if (added > 0) showToast(added + ' saved to ' + category + '!');
  showTab('bookmarks', document.getElementById('tabBookmarks'));
}

function clearAllBookmarks() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1e2732;border-radius:16px;padding:24px;width:300px;text-align:center;border:1px solid #2f3336;';
  dialog.innerHTML = `<div style="font-size:36px;margin-bottom:12px;">⚠️</div><h3 style="font-size:16px;margin-bottom:8px;color:#e7e9ea;font-weight:700;">Clear All Bookmarks?</h3><p style="font-size:13px;color:#71767b;margin-bottom:20px;line-height:1.6;">This will permanently delete all ${bookmarks.length} bookmarks.<br><strong style="color:#e7e9ea">Export a backup first!</strong></p><div style="display:flex;gap:10px;"><button id="cancelClear" style="flex:1;padding:10px;border:1px solid #2f3336;border-radius:20px;background:transparent;cursor:pointer;font-size:14px;color:#e7e9ea;font-weight:600;">Cancel</button><button id="confirmClear" style="flex:1;padding:10px;border:none;border-radius:20px;background:#f4212e;color:white;cursor:pointer;font-size:14px;font-weight:700;">Clear All</button></div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.getElementById('cancelClear').addEventListener('click', () => overlay.remove());
  document.getElementById('confirmClear').addEventListener('click', () => { bookmarks = []; saveData(); updateUI(); overlay.remove(); showToast('All bookmarks cleared!'); });
}

function exportJSON() {
  download('xbookmarks_backup_' + getDate() + '.json', JSON.stringify({ bookmarks, categories, exportedAt: new Date().toISOString() }, null, 2), 'application/json');
  showToast('JSON exported!');
}

function exportCSV() {
  const rows = [['Author','Text','Category','URL','Date']];
  bookmarks.forEach(b => rows.push([`"${(b.author||'').replace(/"/g,'""')}"`,`"${(b.text||'').substring(0,200).replace(/"/g,'""')}"`,`"${b.category||''}"`,`"${b.url||''}"`,`"${new Date(b.savedAt).toLocaleDateString()}"`]));
  download('xbookmarks_' + getDate() + '.csv', rows.map(r=>r.join(',')).join('\n'), 'text/csv');
  showToast('CSV exported!');
}

function exportHTML() {
  const rows = bookmarks.map(b => `<tr><td>${b.author||''}</td><td>${(b.text||'').substring(0,150)}</td><td>${b.category||''}</td><td>${b.url?`<a href="${b.url}">View</a>`:''}</td><td>${new Date(b.savedAt).toLocaleDateString()}</td></tr>`).join('');
  download('xbookmarks_' + getDate() + '.html', `<!DOCTYPE html><html><head><title>X Bookmarks</title><style>body{font-family:sans-serif;padding:20px;background:#000;color:#e7e9ea}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #2f3336;font-size:13px;text-align:left}th{background:#1d9bf0;color:white}a{color:#1d9bf0}</style></head><body><h1>𝕏 Bookmarks — ${bookmarks.length} saved</h1><table><tr><th>Author</th><th>Text</th><th>Category</th><th>Link</th><th>Date</th></tr>${rows}</table></body></html>`, 'text/html');
  showToast('HTML exported!');
}

function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.bookmarks || !Array.isArray(data.bookmarks)) { showToast('Invalid backup file!'); return; }

      const getTweetId = url => { const m = (url||'').match(/\/status\/(\d+)/); return m ? m[1] : null; };

      const updatedBookmarks = bookmarks.map(b => ({ ...b }));
      const idIndexMap = {};
      updatedBookmarks.forEach((b, i) => { const id = getTweetId(b.url); if (id) idIndexMap[id] = i; });

      let updated = 0;
      let added = 0;

      data.bookmarks.forEach(imported => {
        const tweetId = getTweetId(imported.url);
        if (tweetId && idIndexMap[tweetId] !== undefined) {
          updatedBookmarks[idIndexMap[tweetId]].category = imported.category;
          updatedBookmarks[idIndexMap[tweetId]].dirty = true;
          updated++;
        } else {
          updatedBookmarks.push({ ...imported, dirty: true });
          added++;
        }
      });

      const updatedCategories = [...categories];
      if (data.categories) {
        data.categories.forEach(c => { if (!updatedCategories.includes(c)) updatedCategories.push(c); });
      }

      chrome.storage.local.set({ bookmarks: updatedBookmarks, categories: updatedCategories }, () => {
        bookmarks = updatedBookmarks;
        categories = updatedCategories;
        updateUI();
        showToast(`✅ ${updated} updated, ${added} added!`);
      });

    } catch(err) {
      showToast('Error reading file!');
    }
  };
  reader.readAsText(file);
}

function download(filename, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
}

function getDate() { return new Date().toISOString().split('T')[0]; }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}
