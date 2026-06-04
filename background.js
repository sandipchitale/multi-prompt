const AI_URLS = {
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/"
};

const MODEL_TITLES = { gemini: "Gemini", claude: "Claude", chatgpt: "ChatGPT" };

// "Bogus" bookkeeping bookmark used to persist per-session metadata (model
// order + the turn-id ledger) inside the session folder. It uses the reserved
// `.invalid` TLD so it can never accidentally navigate anywhere, and the
// extension recognises and skips it when reopening a session.
const META_HOST = 'multi-prompt.invalid';
const META_URL_PREFIX = 'https://multi-prompt.invalid/session#';
const META_TITLE = '⚙︎ Multi-Prompt session data — do not open';

// Match a tab to a model by comparing hostnames, so a stray URL that merely
// contains the host string somewhere (e.g. in a query parameter) is not
// mistaken for the chatbot tab.
function tabMatchesModel(tab, model) {
  if (!tab.url) return false;
  try {
    return new URL(tab.url).hostname === new URL(AI_URLS[model]).hostname;
  } catch (e) {
    return false;
  }
}

// Identify which model (if any) a URL belongs to by hostname.
function modelForUrl(url) {
  for (const model of Object.keys(AI_URLS)) {
    try {
      if (new URL(url).hostname === new URL(AI_URLS[model]).hostname) return model;
    } catch (e) { /* ignore */ }
  }
  return null;
}

// Has the conversation URL stabilised into a resumable permalink, rather than
// still being the blank "/new" launcher? Used to know when it is worth pointing
// a session bookmark at it.
function isStableConversationUrl(model, url) {
  try {
    const path = new URL(url).pathname;
    if (model === 'claude') return path.startsWith('/chat/');
    if (model === 'chatgpt') return path.startsWith('/c/') || path.startsWith('/g/');
    if (model === 'gemini') return /^\/app\/.+/.test(path);
  } catch (e) { /* ignore */ }
  return false;
}

// Mint a unique, roughly time-ordered id for one broadcast "turn". The same id
// is handed to every model that participates in the broadcast (the source plus
// all injection targets) so their rendered turns can later be matched exactly
// instead of by fuzzy prompt-text heuristics.
function generateTurnId() {
  return 'mp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Normalise a prompt down to a short prefix for the ledger — enough to sanity
// check alignment on reattach without bloating the bookkeeping bookmark.
function normalizePromptPrefix(text) {
  return (text || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function isMetaBookmarkUrl(url) {
  try { return new URL(url).hostname === META_HOST; } catch (e) { return false; }
}

function buildMetaUrl(data) {
  return META_URL_PREFIX + encodeURIComponent(JSON.stringify(data));
}

function parseMetaUrl(url) {
  try {
    return JSON.parse(decodeURIComponent(url.slice(url.indexOf('#') + 1)));
  } catch (e) {
    return null;
  }
}

// --- Cross-browser capability shims ---------------------------------------
//
// Safari Web Extensions don't implement chrome.bookmarks (so the Saved Sessions
// feature can't work there) and only gained chrome.storage.session in 16.4.
// Feature-detect both so the core tile/broadcast flow keeps working everywhere,
// gracefully disabling session persistence instead of throwing.

const BOOKMARKS_AVAILABLE =
  typeof chrome.bookmarks !== 'undefined' && !!chrome.bookmarks &&
  typeof chrome.bookmarks.create === 'function';

// A storage.session stand-in for browsers that lack it. It lives only in the
// service worker's memory, which is acceptable: the data it holds (managed
// window ids, the active session) is itself only meaningful while those windows
// are open.
function createMemorySessionStore() {
  let data = {};
  const asList = (keys) => Array.isArray(keys) ? keys : [keys];
  return {
    get(keys) {
      const out = {};
      for (const k of asList(keys)) if (k in data) out[k] = data[k];
      return Promise.resolve(out);
    },
    set(items) { Object.assign(data, items); return Promise.resolve(); },
    remove(keys) {
      for (const k of asList(keys)) delete data[k];
      return Promise.resolve();
    }
  };
}

const sessionStore = (chrome.storage && chrome.storage.session)
  ? chrome.storage.session
  : createMemorySessionStore();

// --- Managed window bookkeeping (storage.session) -------------------------

async function getManagedWindowIds() {
  const result = await sessionStore.get(['managedWindowIds']);
  return new Set(result.managedWindowIds || []);
}

async function setManagedWindowIds(ids) {
  await sessionStore.set({ managedWindowIds: Array.from(ids) });
}

async function removeManagedWindowId(windowId) {
  const ids = await getManagedWindowIds();
  ids.delete(windowId);
  await setManagedWindowIds(ids);
}

// --- Active session bookkeeping (storage.session) -------------------------
//
// The active session links the live tiled windows to their saved record (id in
// `folderId`) and carries the working copy of the turn-id ledger. The durable
// copy lives in the session store, so this can safely evaporate when the browser
// (and thus the windows) restarts.

async function getActiveSession() {
  const result = await sessionStore.get(['activeSession']);
  return result.activeSession || null;
}

async function setActiveSession(session) {
  await sessionStore.set({ activeSession: session });
}

async function clearActiveSession() {
  await sessionStore.remove('activeSession');
}

// Clean up closed windows, and forget the active session once its windows go.
chrome.windows.onRemoved.addListener(async (windowId) => {
  await removeManagedWindowId(windowId);
  const session = await getActiveSession();
  if (session && session.windows) {
    const stillOpen = Object.values(session.windows).some(id => id !== windowId);
    if (!stillOpen) await clearActiveSession();
  }
});

// Keep a session's per-model saved URL pointed at the live conversation URL as
// it stabilises, so the saved session resumes the real chat rather than a blank
// one. Persisted via whichever session store is active (bookmarks or storage).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) captureSessionUrl(changeInfo.url, tabId, tab && tab.windowId);
});

// --- Message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'new_chat') {
    handleNewChat(request.models, request.screenInfo);
    sendResponse({ status: 'new_chat_sent' });
  } else if (request.action === 'rearrange_tiles') {
    rearrangeTiles(request.models);
    sendResponse({ status: 'rearranging' });
  } else if (request.action === 'broadcast_prompt') {
    const turnId = generateTurnId();
    handleBroadcast(request.prompt, request.source, sender, turnId);
    sendResponse({ status: 'broadcasted', turnId: turnId });
  } else if (request.action === 'export_chats') {
    handleExport(request.models).then(history => {
      sendResponse({ status: 'success', history: history });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'close_tiles') {
    closeTiledWindows().then(() => {
      sendResponse({ status: 'closed' });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'list_sessions') {
    listSessions().then(sessions => {
      sendResponse({ status: 'success', sessions: sessions });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'open_session') {
    openSession(request.folderId, request.screenInfo).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'delete_session') {
    deleteSession(request.folderId).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'query_managed') {
    // A content script asking whether its window is part of a live Multi-Prompt
    // session, so it knows whether to show its in-page floating button.
    isWindowManaged(sender).then(managed => sendResponse({ managed: managed }));
    return true;
  } else if (request.action === 'open_popup') {
    // The in-page floating button forwards its click here: content scripts can't
    // open the action popup themselves, but the service worker can — and this
    // works even when the toolbar icon is hidden in the overflow menu (the very
    // case the floating button exists to cover for narrow tiled windows).
    openActionPopup(sender).finally(() => sendResponse({ ok: true }));
    return true;
  } else if (request.action === 'session_url') {
    // A chatbot content script reporting its current URL — the reliable way to
    // learn the conversation permalink after an SPA history navigation, which
    // tabs.onUpdated doesn't report in Safari.
    if (sender && sender.tab && request.url) {
      captureSessionUrl(request.url, sender.tab.id, sender.tab.windowId);
    }
    sendResponse({ ok: true });
  }
});

async function isWindowManaged(sender) {
  if (!sender || !sender.tab) return false;
  const ids = await getManagedWindowIds();
  return ids.has(sender.tab.windowId);
}

async function openActionPopup(sender) {
  const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
  // Safari's action.openPopup anchors to the toolbar of the active window, so
  // focus the window the button was clicked in first — otherwise it can no-op
  // for a tiled window that isn't currently frontmost.
  if (windowId != null) {
    try { await chrome.windows.update(windowId, { focused: true }); } catch (e) { /* best effort */ }
  }
  if (chrome.action && typeof chrome.action.openPopup === 'function') {
    try {
      await chrome.action.openPopup(windowId != null ? { windowId: windowId } : {});
      return;
    } catch (e) {
      // Safari rejects this for some windows (notably fresh New Chat windows);
      // fall through to the standalone-window path below.
      console.warn("action.openPopup failed, falling back to a window:", e);
    }
  }
  await openPopupWindow();
}

// Open popup.html as a small standalone window, reusing an existing one rather
// than stacking duplicates.
async function openPopupWindow() {
  const url = chrome.runtime.getURL('popup.html');
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.tabs && w.tabs.some(t => t.url && t.url.split('#')[0] === url)) {
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
  } catch (e) { /* fall through to creating a fresh window */ }
  const win = await chrome.windows.create({
    url: url, type: "popup", width: 580, height: 720, focused: true
  });
  // Safari ignores the size passed to create; re-apply it once the window exists.
  try {
    await chrome.windows.update(win.id, { state: "normal", width: 580, height: 720 });
  } catch (e) { /* best effort */ }
}

// --- Window geometry helpers ----------------------------------------------

function computeGeom(screenInfo, i, n) {
  const { availLeft, availTop, availWidth, availHeight } = screenInfo;
  const baseWidth = Math.floor(availWidth / n);
  const left = availLeft + i * baseWidth;
  // Give the last window any leftover pixels so the row spans the full width.
  const width = (i === n - 1) ? (availWidth - i * baseWidth) : baseWidth;
  return { left: left, top: availTop, width: width, height: availHeight };
}

async function createWindow(url, geom) {
  return await chrome.windows.create({
    url: url,
    left: geom.left,
    top: geom.top,
    width: geom.width,
    height: geom.height,
    focused: true,
    type: "normal"
  });
}

// Re-apply tile geometry to a set of windows once they all exist. Each
// windows.create above opens focused, so a later window can shove earlier ones
// around, and Safari ignores the bounds passed to create and finishes placing a
// window asynchronously after it loads. A single pass over all the windows —
// after a short settle delay, repeated once — is far more reliable than trying
// to position each window as it is created.
async function tileWindows(orderedWindowIds, screenInfo) {
  const n = orderedWindowIds.length;
  const pass = async () => {
    for (let i = 0; i < n; i++) {
      try {
        await chrome.windows.update(orderedWindowIds[i], {
          state: "normal",
          ...computeGeom(screenInfo, i, n)
        });
      } catch (e) {
        console.warn("Could not tile window:", e);
      }
    }
  };
  await new Promise((r) => setTimeout(r, 350));
  await pass();
  await new Promise((r) => setTimeout(r, 350));
  await pass();
}

// Resolve a freshly created window's first tab. chrome.windows.create returns
// the tab in `win.tabs` on Chrome, but not reliably on Safari — so fall back to
// querying the window when it's missing. Without a real tab id, the
// tabs.onUpdated URL tracker can't match the tab and the saved session never
// learns the real conversation URL (it stays on the blank launcher).
async function firstTabOf(win) {
  const tab = win && win.tabs && win.tabs[0];
  if (tab) return tab;
  if (!win || win.id == null) return null;
  try {
    const tabs = await chrome.tabs.query({ windowId: win.id });
    return (tabs && tabs[0]) || null;
  } catch (e) {
    return null;
  }
}

// Create one tiled window per model (in order) at the URL `urlFor(model)`,
// returning the window-id and tab-id maps plus the managed-window set. Shared by
// fresh sessions and reopened ones.
async function openTiledWindows(order, urlFor, screenInfo) {
  const windows = {};
  const tabs = {};
  const managed = new Set();
  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    const win = await createWindow(urlFor(model), computeGeom(screenInfo, i, order.length));
    const tab = await firstTabOf(win);
    windows[model] = win.id;
    tabs[model] = tab ? tab.id : null;
    managed.add(win.id);
  }
  return { windows: windows, tabs: tabs, managed: managed };
}

// Deliver a message to a content script that may still be initialising, retrying
// briefly until the listener is registered.
function sendWhenReady(tabId, message, attempt) {
  attempt = attempt || 0;
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError && attempt < 20) {
      setTimeout(() => sendWhenReady(tabId, message, attempt + 1), 500);
    }
  });
}

// --- Bookmark / session-folder helpers ------------------------------------

function findParentFolder() {
  return new Promise((resolve) => {
    chrome.bookmarks.search({ title: "Multi-prompt" }, (results) => {
      resolve(results.find(r => !r.url) || null);
    });
  });
}

async function ensureParentFolder() {
  const existing = await findParentFolder();
  if (existing) return existing;
  return await new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId: "1", title: "Multi-prompt" }, (folder) => {
      if (chrome.runtime.lastError) {
        // Fallback: create without parentId (usually "Other Bookmarks").
        chrome.bookmarks.create({ title: "Multi-prompt" }, (fallback) => {
          chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(fallback);
        });
      } else {
        resolve(folder);
      }
    });
  });
}

// Human-readable timestamp used in session titles (shared by both stores).
function sessionTimestamp() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
         `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function createSessionFolder(parentId) {
  return await new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId: parentId, title: `Session - ${sessionTimestamp()}` }, (folder) => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(folder);
    });
  });
}

function createBookmark(parentId, title, url) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId: parentId, title: title, url: url }, (bm) => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(bm);
    });
  });
}

// --- Session stores --------------------------------------------------------
//
// Saved sessions are persisted through one of two interchangeable stores,
// chosen once at startup by `sessionRepo`:
//
//   • bookmarkRepo — the original Chrome behaviour: a "Multi-prompt" bookmark
//     folder with one sub-folder per session, a bookmark per chatbot, and a
//     bookkeeping meta bookmark. Visible (and openable) directly in the browser.
//   • localRepo — a chrome.storage.local fallback for browsers without the
//     bookmarks API (Safari). Not visible as bookmarks, but still listable,
//     openable, and deletable from the Multi-Prompt popup.
//
// Both expose the same interface and operate on the active-session object, which
// carries the durable id in `folderId` (a bookmark folder id, or a storage
// record id) plus any store-specific handles (`bookmarks`, `metaBookmarkId`).
//
//   createSession(session, models, urls) — create the durable record; sets
//       session.folderId (+ store handles).
//   saveMeta(session)                    — persist order + turn ledger.
//   setModelUrl(session, model, url)     — update one chatbot's saved URL.
//   listSessions()                       — [{ folderId, title, models }], newest first.
//   loadSession(id)                      — { order, turns, urls, bookmarks, metaBookmarkId }.
//   removeSession(id)                    — delete the durable record.

const bookmarkRepo = {
  async createSession(session, models, urls) {
    const parent = await ensureParentFolder();
    const folder = await createSessionFolder(parent.id);
    session.folderId = folder.id;
    session.metaBookmarkId = null;
    session.bookmarks = {};
    for (const model of models) {
      const bm = await createBookmark(folder.id, MODEL_TITLES[model], urls[model] || AI_URLS[model]);
      session.bookmarks[model] = bm.id;
    }
  },

  async saveMeta(session) {
    if (!session.folderId) return;
    const url = buildMetaUrl({ v: 1, order: session.order, turns: session.ledger });
    if (session.metaBookmarkId) {
      await new Promise((resolve) => {
        chrome.bookmarks.update(session.metaBookmarkId, { url: url },
          () => resolve(void chrome.runtime.lastError));
      });
    } else {
      const bm = await createBookmark(session.folderId, META_TITLE, url);
      session.metaBookmarkId = bm.id;
    }
  },

  async setModelUrl(session, model, url) {
    if (session.bookmarks && session.bookmarks[model]) {
      await new Promise((resolve) => {
        chrome.bookmarks.update(session.bookmarks[model], { url: url },
          () => resolve(void chrome.runtime.lastError));
      });
    }
  },

  async listSessions() {
    const parent = await findParentFolder();
    if (!parent) return [];
    const sub = await new Promise((resolve) => chrome.bookmarks.getSubTree(parent.id, resolve));
    const folders = (sub[0].children || []).filter(c => !c.url);
    const sessions = folders.map(folder => {
      const models = (folder.children || [])
        .filter(c => c.url && !isMetaBookmarkUrl(c.url))
        .map(c => modelForUrl(c.url))
        .filter(Boolean);
      return { folderId: folder.id, title: folder.title, models: models };
    });
    return sessions.reverse(); // newest first
  },

  async loadSession(folderId) {
    const sub = await new Promise((resolve) => chrome.bookmarks.getSubTree(folderId, resolve));
    if (!sub || !sub[0]) throw new Error("Session folder not found.");
    const children = sub[0].children || [];

    let meta = null;
    let metaBookmarkId = null;
    const bookmarks = {};
    const urls = {};
    for (const child of children) {
      if (!child.url) continue;
      if (isMetaBookmarkUrl(child.url)) {
        meta = parseMetaUrl(child.url);
        metaBookmarkId = child.id;
        continue;
      }
      const model = modelForUrl(child.url);
      if (model) { bookmarks[model] = child.id; urls[model] = child.url; }
    }

    const order = (meta && Array.isArray(meta.order))
      ? meta.order.filter(m => urls[m])
      : Object.keys(urls);
    const turns = (meta && Array.isArray(meta.turns)) ? meta.turns : [];
    return { order: order, turns: turns, urls: urls, bookmarks: bookmarks, metaBookmarkId: metaBookmarkId };
  },

  async removeSession(folderId) {
    await new Promise((resolve, reject) => {
      chrome.bookmarks.removeTree(folderId, () => {
        chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve();
      });
    });
  }
};

// storage.local-backed store. All sessions live under one key as a map keyed by
// a generated id; each record holds its title, creation time, model order, turn
// ledger, and the per-model conversation URLs.
const LOCAL_SESSIONS_KEY = 'mp_savedSessions';

async function localLoadSessions() {
  const r = await chrome.storage.local.get([LOCAL_SESSIONS_KEY]);
  return r[LOCAL_SESSIONS_KEY] || {};
}

async function localStoreSessions(map) {
  await chrome.storage.local.set({ [LOCAL_SESSIONS_KEY]: map });
}

const localRepo = {
  async createSession(session, models, urls) {
    const id = 'mp_s_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const map = await localLoadSessions();
    map[id] = {
      id: id,
      title: `Session - ${sessionTimestamp()}`,
      createdAt: Date.now(),
      order: models.slice(),
      turns: [],
      urls: { ...urls }
    };
    await localStoreSessions(map);
    session.folderId = id;
    session.metaBookmarkId = null;
    session.bookmarks = {};
  },

  async saveMeta(session) {
    if (!session.folderId) return;
    const map = await localLoadSessions();
    const rec = map[session.folderId];
    if (!rec) return;
    rec.order = session.order.slice();
    rec.turns = session.ledger.slice();
    await localStoreSessions(map);
  },

  async setModelUrl(session, model, url) {
    if (!session.folderId) return;
    const map = await localLoadSessions();
    const rec = map[session.folderId];
    if (!rec) return;
    rec.urls = rec.urls || {};
    rec.urls[model] = url;
    await localStoreSessions(map);
  },

  async listSessions() {
    const map = await localLoadSessions();
    const records = Object.values(map).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return records.map(rec => ({
      folderId: rec.id,
      title: rec.title,
      models: (rec.order && rec.order.length) ? rec.order : Object.keys(rec.urls || {})
    }));
  },

  async loadSession(id) {
    const map = await localLoadSessions();
    const rec = map[id];
    if (!rec) throw new Error("Session not found.");
    const urls = rec.urls || {};
    const order = ((rec.order && rec.order.length) ? rec.order : Object.keys(urls)).filter(m => urls[m]);
    return { order: order, turns: rec.turns || [], urls: urls, bookmarks: {}, metaBookmarkId: null };
  },

  async removeSession(id) {
    const map = await localLoadSessions();
    if (map[id]) {
      delete map[id];
      await localStoreSessions(map);
    }
  }
};

const sessionRepo = BOOKMARKS_AVAILABLE ? bookmarkRepo : localRepo;

// Persist the active session's durable record on demand. Sessions are saved
// lazily — only once the user has actually sent a prompt — so empty launcher
// windows that were tiled but never used don't clutter the saved list. Seeds
// the record with each model's current tab URL (a launcher at first; the URL
// trackers upgrade it to the real conversation permalink as it stabilises).
async function ensureSessionPersisted(session) {
  if (!session || session.folderId) return false;
  const urls = {};
  for (const model of session.order) {
    let url = AI_URLS[model];
    const tabId = session.tabs && session.tabs[model];
    if (tabId != null) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.url) url = t.url;
      } catch (e) { /* tab gone; fall back to the launcher URL */ }
    }
    urls[model] = url;
  }
  await sessionRepo.createSession(session, session.order, urls);
  return true;
}

// Append one broadcast turn to the active session's ledger and persist it. The
// first recorded turn is what promotes a tiled-but-unsaved session into a saved
// one.
async function recordLedgerTurn(turnId, prompt) {
  const session = await getActiveSession();
  if (!session) return;
  session.ledger.push({ id: turnId, p: normalizePromptPrefix(prompt) });
  try {
    await ensureSessionPersisted(session);
    await sessionRepo.saveMeta(session);
  } catch (e) {
    console.warn("Could not persist session ledger:", e);
  }
  await setActiveSession(session);
}

// A chatbot's conversation URL has settled (reported by tabs.onUpdated or, where
// that doesn't fire for SPA history navigations — e.g. Safari — by the content
// script). Update the saved session's URL for that model, if the URL is a stable
// permalink, the session is already persisted, and the tab belongs to it.
async function captureSessionUrl(url, tabId, windowId) {
  const model = modelForUrl(url);
  if (!model || !isStableConversationUrl(model, url)) return;
  const session = await getActiveSession();
  if (!session || !session.folderId) return;
  const matchesTab = tabId != null && session.tabs && session.tabs[model] === tabId;
  const matchesWindow = windowId != null && session.windows && session.windows[model] === windowId;
  if (!matchesTab && !matchesWindow) return;
  try {
    await sessionRepo.setModelUrl(session, model, url);
  } catch (e) {
    console.warn("Could not update saved session URL:", e);
  }
}

// --- New chat / tiling -----------------------------------------------------
//
// "New Chat" is the single entry point: if the selected models are already
// tiled it re-tiles them and starts a fresh chat in each; otherwise it opens
// fresh tiled windows (which begin on a blank chat). Either way it starts a
// fresh active session whose durable record is saved lazily on the first prompt.

async function handleNewChat(models, screenInfo) {
  try {
    const n = models.length;
    if (n === 0) return;

    const session = await getActiveSession();
    if (session && await sessionWindowsMatch(session, models)) {
      // Reuse the existing tiled windows: re-tile, start a fresh chat in each.
      for (let i = 0; i < n; i++) {
        await chrome.windows.update(session.windows[models[i]], {
          state: "normal", focused: true, ...computeGeom(screenInfo, i, n)
        });
      }
      await sendActionToTabs(models, 'new_chat');
      await rotateSession(session, models);
    } else {
      // Nothing usable open: tile fresh windows and start a new session.
      await startFreshSession(models, screenInfo);
    }
  } catch (err) {
    console.error("Failed to start new chat:", err);
  }
}

// Start a brand new (unsaved) active session for the conversations now living in
// the given windows (reused from the previous session), leaving the old session
// saved. The durable record is created lazily on the first prompt.
async function rotateSession(session, models) {
  const next = {
    folderId: null,
    metaBookmarkId: null,
    order: models.slice(),
    windows: session.windows,
    tabs: session.tabs,
    bookmarks: {},
    ledger: []
  };
  await setActiveSession(next);
}

// True only if the active session has a live window for exactly this set of models.
async function sessionWindowsMatch(session, models) {
  if (!session.windows) return false;
  const sessionModels = Object.keys(session.windows);
  if (sessionModels.length !== models.length) return false;
  for (const model of models) {
    const wid = session.windows[model];
    if (!wid) return false;
    try { await chrome.windows.get(wid); } catch (e) { return false; }
  }
  return true;
}

// Open fresh chats for each model, tiled. The active session is set up here but
// its durable record is created lazily on the first prompt (see
// ensureSessionPersisted), so tiling without ever typing leaves nothing saved.
async function startFreshSession(models, screenInfo) {
  await closeTiledWindows();

  const { windows, tabs, managed } = await openTiledWindows(models, (m) => AI_URLS[m], screenInfo);
  const session = {
    folderId: null,
    metaBookmarkId: null,
    order: models.slice(),
    windows: windows,
    tabs: tabs,
    bookmarks: {},
    ledger: []
  };

  await setManagedWindowIds(managed);
  await setActiveSession(session);

  // Proactively show the in-page button in each managed window. Fresh launcher
  // pages load fast and may have queried query_managed before the ids above were
  // stored, so don't rely on that poll alone.
  notifyManagedButtons(session);

  await tileWindows(models.map((m) => windows[m]), screenInfo);
}

// Tell each of a session's chatbot tabs to show its floating button, retrying
// until the content script is ready.
function notifyManagedButtons(session) {
  for (const model of Object.keys(session.tabs || {})) {
    const tabId = session.tabs[model];
    if (tabId != null) sendWhenReady(tabId, { action: 'show_managed_button' });
  }
}

async function closeTiledWindows() {
  const ids = await getManagedWindowIds();
  for (const windowId of ids) {
    try {
      await chrome.windows.remove(windowId);
    } catch (e) {
      console.warn(`Window ${windowId} was already closed or could not be removed:`, e);
    }
  }
  await setManagedWindowIds(new Set());
  await clearActiveSession();
}

async function sendActionToTabs(models, actionType) {
  try {
    const allTabs = await chrome.tabs.query({});
    const managedIds = await getManagedWindowIds();
    for (const model of models) {
      const tab = allTabs.find(t => tabMatchesModel(t, model) && managedIds.has(t.windowId)) ||
                  allTabs.find(t => tabMatchesModel(t, model));
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: actionType }, () => void chrome.runtime.lastError);
      } else {
        console.warn(`Attempted to send ${actionType} to ${model} but no tab was found.`);
      }
    }
  } catch (err) {
    console.error(`Failed to send ${actionType}:`, err);
  }
}

// --- Swap ------------------------------------------------------------------

// Re-tile the open managed windows to match `orderedModels` (the selected
// models, left-to-right). Unlike an adjacent swap, this handles a drag across
// several positions: it collects the current geometry slots, sorts them
// left-to-right, and reassigns each model to the slot at its new index.
async function rearrangeTiles(orderedModels) {
  try {
    const managedIds = await getManagedWindowIds();
    const allTabs = await chrome.tabs.query({});

    // Open managed windows for the requested models, in the requested order.
    const entries = [];
    for (const model of orderedModels) {
      const tab = allTabs.find(t => tabMatchesModel(t, model) && managedIds.has(t.windowId));
      if (tab) {
        const win = await chrome.windows.get(tab.windowId);
        entries.push({ model, win });
      }
    }
    if (entries.length < 2) return;

    // The physical slots these windows currently occupy, left-to-right.
    const slots = entries
      .map(e => ({ left: e.win.left, top: e.win.top, width: e.win.width, height: e.win.height }))
      .sort((a, b) => a.left - b.left);

    // Assign each model (in the requested order) to the matching slot.
    for (let i = 0; i < entries.length; i++) {
      const slot = slots[i];
      await chrome.windows.update(entries[i].win.id, {
        state: "normal", left: slot.left, top: slot.top, width: slot.width, height: slot.height
      });
    }

    // Keep the session's recorded left-to-right order in step.
    const session = await getActiveSession();
    if (session && session.order) {
      const present = orderedModels.filter(m => session.order.includes(m));
      session.order = present.concat(session.order.filter(m => !present.includes(m)));
      await sessionRepo.saveMeta(session).catch(() => {});
      await setActiveSession(session);
    }
  } catch (err) {
    console.error("Failed to rearrange tiles:", err);
  }
}

// --- Broadcast -------------------------------------------------------------

async function handleBroadcast(prompt, source, sender, turnId) {
  try {
    const managedIds = await getManagedWindowIds();
    if (!sender.tab || !managedIds.has(sender.tab.windowId)) {
      console.warn(`Blocked broadcast: source window is not extension-managed.`);
      return;
    }

    // Record the turn in the session ledger (covers single-model sessions too).
    recordLedgerTurn(turnId, prompt);

    const { selectedModels } = await chrome.storage.local.get(['selectedModels']);
    const targetModels = (selectedModels || ['gemini', 'claude', 'chatgpt']).filter(m => m !== source);
    const allTabs = await chrome.tabs.query({});

    for (const model of targetModels) {
      const tab = allTabs.find(t => tabMatchesModel(t, model));
      if (tab && managedIds.has(tab.windowId)) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'inject_prompt',
          prompt: prompt,
          turnId: turnId
        }, () => void chrome.runtime.lastError);
      }
    }
  } catch (err) {
    console.error("Broadcast failed:", err);
  }
}

// --- Export ----------------------------------------------------------------

async function handleExport(models) {
  const allTabs = await chrome.tabs.query({});
  const managedWindowIds = await getManagedWindowIds();
  const results = {};

  for (const model of models) {
    const tab = allTabs.find(t => tabMatchesModel(t, model) && managedWindowIds.has(t.windowId));
    if (tab) {
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, { action: 'extract_chat_history' }, (res) => {
            chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(res);
          });
        });
        results[model] = (response && response.success) ? response.history : [];
      } catch (err) {
        console.warn(`Could not extract history for ${model}:`, err);
        results[model] = [];
      }
    } else {
      results[model] = [];
    }
  }
  return results;
}

// --- Saved sessions (picker) -----------------------------------------------

async function listSessions() {
  return await sessionRepo.listSessions();
}

async function openSession(folderId, screenInfo) {
  const loaded = await sessionRepo.loadSession(folderId);
  const order = loaded.order;
  if (!order || order.length === 0) throw new Error("No chatbots saved in this session.");

  await closeTiledWindows();

  const { windows, tabs, managed } = await openTiledWindows(
    order, (m) => loaded.urls[m] || AI_URLS[m], screenInfo);
  const session = {
    folderId: folderId,
    metaBookmarkId: loaded.metaBookmarkId || null,
    order: order.slice(),
    windows: windows,
    tabs: tabs,
    bookmarks: loaded.bookmarks || {},
    ledger: Array.isArray(loaded.turns) ? loaded.turns : []
  };

  // Re-stamp the reloaded turns with their original ids so alignment survives.
  if (session.ledger.length) {
    for (const model of order) {
      if (tabs[model] != null) {
        sendWhenReady(tabs[model], { action: 'reattach_turns', turns: session.ledger });
      }
    }
  }

  await setManagedWindowIds(managed);
  await setActiveSession(session);

  notifyManagedButtons(session);

  await tileWindows(order.map((m) => windows[m]), screenInfo);
}

async function deleteSession(folderId) {
  await sessionRepo.removeSession(folderId);
  const session = await getActiveSession();
  if (session && session.folderId === folderId) {
    // The record is gone; detach it from the live windows (which stay open).
    session.folderId = null;
    session.metaBookmarkId = null;
    session.bookmarks = {};
    await setActiveSession(session);
  }
}
