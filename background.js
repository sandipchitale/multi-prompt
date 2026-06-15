const AI_URLS = {
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/"
};

const MODEL_TITLES = { gemini: "Gemini", claude: "Claude", chatgpt: "ChatGPT" };

// True under Safari's web-extension runtime (its pages and background all live
// on the safari-web-extension: scheme). Used to keep Safari-only workarounds
// off the Chrome code paths entirely.
const IS_SAFARI_EXTENSION =
  typeof location !== 'undefined' && location.protocol === 'safari-web-extension:';

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

// Bookmark URLs have practical length limits (and sync caps below the raw URL
// max), so the session ledger is spread across as many bookkeeping bookmarks as
// it needs — a primary (seq 0, carrying order + custom title) plus sequenced
// continuations (-02, -03, …). Each holds a chunk of turns small enough to keep
// its URL under META_URL_MAX. All share the reserved META_HOST and carry their
// `seq` in the payload, so readers just gather every meta bookmark in the
// folder, sort by seq, and concatenate the turns.
const META_URL_MAX = 7000;

function encodeMetaUrl(data) {
  return META_URL_PREFIX + encodeURIComponent(JSON.stringify(data));
}

// Single-bookmark encode with a last-resort fallback (drop prompt prefixes,
// keeping ids — all alignment needs) for the rare write that isn't chunked.
function buildMetaUrl(data) {
  let url = encodeMetaUrl(data);
  if (url.length > META_URL_MAX && Array.isArray(data.turns) && data.turns.length) {
    url = encodeMetaUrl({ ...data, turns: data.turns.map(t => ({ id: t.id })) });
  }
  return url;
}

// Split a session's order + custom title + turn ledger into a list of meta
// payloads, each whose encoded URL stays under META_URL_MAX. Always returns at
// least one payload (the primary), even for an empty ledger.
function chunkSessionMeta(order, customTitle, turns) {
  turns = Array.isArray(turns) ? turns : [];
  const payloads = [];
  let idx = 0;
  let seq = 0;
  do {
    const base = seq === 0 ? { v: 1, seq: 0, order: order || [] } : { v: 1, seq: seq };
    if (seq === 0 && customTitle) base.customTitle = customTitle;
    base.turns = [];
    while (idx < turns.length) {
      const candidate = base.turns.concat([turns[idx]]);
      // Accept the turn if it fits, or if this chunk is still empty (guarantees
      // forward progress even for a pathologically large single turn).
      if (base.turns.length >= 1 &&
          encodeMetaUrl({ ...base, turns: candidate }).length > META_URL_MAX) {
        break;
      }
      base.turns = candidate;
      idx++;
    }
    payloads.push(base);
    seq++;
  } while (idx < turns.length);
  return payloads;
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
  if (!session) return;
  // The shared prompt bar closed on its own: just forget it, keep the session.
  if (session.promptBarWindowId === windowId) {
    session.promptBarWindowId = null;
    session.promptBarTabId = null;
    await setActiveSession(session);
    return;
  }
  if (session.windows) {
    const stillOpen = Object.values(session.windows).some(id => id !== windowId);
    if (!stillOpen) {
      // Last chatbot window gone — close the orphaned prompt bar with it.
      if (session.promptBarWindowId != null) {
        try { await chrome.windows.remove(session.promptBarWindowId); } catch (e) { /* gone */ }
      }
      await clearActiveSession();
    }
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
    handleNewChat(request.models, request.screenInfo, !!request.sharedPromptBar);
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
    // Tear down the tiles + bar, and (Safari) the standalone popup.html panel
    // window the [M] button opens — the user asked for everything to go.
    Promise.all([closeTiledWindows(), closeStandalonePopupWindows()]).then(() => {
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
    openSession(request.folderId, request.screenInfo, !!request.sharedPromptBar).then(() => {
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
  } else if (request.action === 'rename_session') {
    renameSession(request.folderId, request.title).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'query_managed') {
    // A content script asking whether its window is part of a live Multi-Prompt
    // session, so it knows whether to show its in-page floating button. When the
    // session has a shared prompt bar, that bar hosts the panel button instead,
    // so the in-page one is suppressed (hasBar).
    Promise.all([isWindowManaged(sender), getActiveSession()]).then(([managed, session]) => {
      sendResponse({ managed: managed, hasBar: !!(session && session.promptBarWindowId) });
    });
    return true;
  } else if (request.action === 'open_popup') {
    // The in-page floating button forwards its click here: content scripts can't
    // open the action popup themselves, but the service worker can — and this
    // works even when the toolbar icon is hidden in the overflow menu (the very
    // case the floating button exists to cover for narrow tiled windows).
    openActionPopup(sender).finally(() => sendResponse({ ok: true }));
    return true;
  } else if (request.action === 'open_workspace') {
    openWorkspace(request.folderId || null).then(() => {
      sendResponse({ status: 'success' });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'workspace_init') {
    // The workspace page is loaded and asking for its pane list. Register its
    // tab and extend the header-stripping rule to it before answering, so the
    // iframes are only created once framing is actually permitted (no race).
    initWorkspace(sender, request.folderId || null).then(result => {
      sendResponse({ status: 'success', order: result.order, urls: result.urls });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'workspace_inject_result') {
    // A pane (content script) reporting whether its injected prompt rendered.
    // Forward only to its own workspace tab's prompt bar.
    forwardPaneResult(request.model, !!request.ok, sender).finally(() => sendResponse({ ok: true }));
    return true;
  } else if (request.action === 'workspace_hello') {
    // A content script running inside a workspace iframe reporting which model
    // its frame hosts, so the shared prompt box can target it by frameId. The
    // response may carry a conversation URL to steer a freshly reloaded pane
    // back to (a frame reload reverts to the blank launcher src).
    registerWorkspaceFrame(request.model, sender, !!request.private)
      .then(result => sendResponse({ ok: true, navigate: (result && result.navigate) || null }))
      .catch(() => sendResponse({ ok: true, navigate: null }));
    return true;
  } else if (request.action === 'workspace_status') {
    // A workspace page polling which of ITS panes are currently registered, for
    // its per-pane connection indicators — plus each pane's private-chat state
    // for the titlebar ghost indicators.
    getWorkspaceForTab(sender && sender.tab && sender.tab.id).then(entry => {
      sendResponse({
        status: 'success',
        models: entry ? Object.keys(entry.frames || {}) : [],
        private: (entry && entry.framePrivate) || {},
        privateMode: !!(entry && entry.privateMode)
      });
    }).catch(() => sendResponse({ status: 'success', models: [], private: {}, privateMode: false }));
    return true;
  } else if (request.action === 'workspace_private') {
    // The workspace bar's Private button: switch every pane in that tab to the
    // site's private/temporary mode and stop persisting the tab's session.
    privatizeWorkspaceTab(sender).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'workspace_broadcast') {
    handleWorkspaceBroadcast(request.prompt, sender).then(result => {
      sendResponse(result);
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'export_workspace') {
    // Export the chats of the panes in the requesting workspace tab.
    exportWorkspaceTab(sender).then(history => {
      sendResponse({ status: 'success', history: history });
    }).catch(err => {
      sendResponse({ status: 'error', error: err.message || String(err) });
    });
    return true;
  } else if (request.action === 'promptbar_init') {
    // The shared prompt bar (Tiled Windows) loaded and asking for the session's
    // model order, so it can render one delivery chip per tiled window.
    getActiveSession().then(session => {
      sendResponse({ status: 'success', order: (session && session.order) || [] });
    }).catch(() => sendResponse({ status: 'success', order: [] }));
    return true;
  } else if (request.action === 'promptbar_status') {
    // The bar polling which of its models still have a live tiled window (for
    // the connection dots) and whether the session has gone private.
    promptbarStatus().then(r => sendResponse(r))
      .catch(() => sendResponse({ status: 'success', order: [], connected: [], private: false }));
    return true;
  } else if (request.action === 'promptbar_private') {
    // The bar's Private button: switch every tiled window to the site's
    // private/temporary mode and stop persisting the session.
    promptbarPrivate().then(r => sendResponse(r))
      .catch(err => sendResponse({ status: 'error', error: err.message || String(err) }));
    return true;
  } else if (request.action === 'tiled_inject_result') {
    // A managed tiled window reporting whether its injected prompt rendered.
    // Forward to the session's prompt bar for its per-window delivery badge.
    forwardTiledResult(request.model, !!request.ok, sender).finally(() => sendResponse({ ok: true }));
    return true;
  } else if (request.action === 'session_url') {
    // A chatbot content script reporting its current URL — the reliable way to
    // learn the conversation permalink after an SPA history navigation, which
    // tabs.onUpdated doesn't report in Safari.
    if (sender && sender.tab && request.url) {
      captureSessionUrl(request.url, sender.tab.id, sender.tab.windowId);
      captureWorkspaceUrl(request.url, sender);
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
    url: url, type: "popup", width: 800, height: 720, focused: true
  });
  // Safari ignores the size passed to create; re-apply it once the window exists.
  try {
    await chrome.windows.update(win.id, { state: "normal", width: 800, height: 720 });
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

// --- Shared prompt bar (Tiled Windows) -------------------------------------
//
// An opt-in, chrome-less app window docked across the bottom that holds the
// shared prompt box, so Tiled Windows gets the same "type once, broadcast to
// all" experience as Tiled in a Tab — and it works on Safari, where Tiled in a
// Tab can't run. The chatbot windows are tiled into the area ABOVE it.
//
// Both Chrome and Safari lose usable height to the window's title bar, so the
// bar needs to be tall enough that the chips row + the 54px prompt-pill row
// aren't squeezed flush against the bottom edge. `.composer` centres its row,
// so the slack becomes balanced top/bottom padding.
const PROMPT_BAR_HEIGHT = 150;

// Bottom margin differs only because the platforms position the window
// differently: Chrome adds its title frame PAST the height we ask (so the real
// window hangs lower — this margin pulls it back on-screen), while Safari keeps
// the title bar INSIDE the height, so it just needs a small gap.
const IS_SAFARI = (() => {
  try { return chrome.runtime.getURL('').startsWith('safari-web-extension:'); }
  catch (e) { return false; }
})();
const PROMPT_BAR_BOTTOM_MARGIN = IS_SAFARI ? 12 : 28;
// A hairline gap between the bottom of the tiles and the top of the bar.
const PROMPT_BAR_TOP_GAP = 4;
// Total vertical space the bar reserves — the tiles are shortened by this.
const PROMPT_BAR_RESERVE = PROMPT_BAR_HEIGHT + PROMPT_BAR_BOTTOM_MARGIN + PROMPT_BAR_TOP_GAP;

// The screen rect the chatbot tiles get: full height, or shortened to leave the
// bottom strip (and its gaps) free when a prompt bar is requested.
function tileScreen(screenInfo, withBar) {
  if (!withBar) return screenInfo;
  return {
    ...screenInfo,
    availHeight: Math.max(240, screenInfo.availHeight - PROMPT_BAR_RESERVE)
  };
}

// The bar spans the full width (the same total span the tile row covers) and
// sits above the bottom of the work area by the bottom margin.
function promptBarGeom(screenInfo) {
  const { availLeft, availTop, availWidth, availHeight } = screenInfo;
  return {
    left: availLeft,
    top: availTop + availHeight - PROMPT_BAR_HEIGHT - PROMPT_BAR_BOTTOM_MARGIN,
    width: availWidth,
    height: PROMPT_BAR_HEIGHT
  };
}

async function createPromptBar(screenInfo) {
  const geom = promptBarGeom(screenInfo);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('promptbar.html'),
    type: "popup", // app-style: no address bar / bookmarks / tab strip
    left: geom.left, top: geom.top, width: geom.width, height: geom.height,
    focused: true
  });
  // Safari ignores the bounds passed to create; re-apply once it exists.
  try { await chrome.windows.update(win.id, { state: "normal", ...geom }); } catch (e) { /* best effort */ }
  const tab = await firstTabOf(win);
  return { windowId: win.id, tabId: tab ? tab.id : null };
}

// Re-apply the bar's geometry in the settle pass, mirroring tileWindows (later
// windows.create calls and Safari's async placement can shove it around).
async function positionPromptBar(windowId, screenInfo) {
  if (windowId == null) return;
  try {
    await chrome.windows.update(windowId, { state: "normal", ...promptBarGeom(screenInfo) });
  } catch (e) {
    console.warn("Could not position prompt bar:", e);
  }
}

// Reconcile an active session's prompt bar with the requested state: create one
// (and add it to the managed set) when wanted and absent, or close it when no
// longer wanted. Mutates `session` in place; the caller persists it.
async function ensurePromptBar(session, screenInfo, withBar) {
  let barId = session.promptBarWindowId || null;
  if (barId != null) {
    try { await chrome.windows.get(barId); } catch (e) { barId = null; } // stale
  }
  if (withBar && barId == null) {
    const bar = await createPromptBar(screenInfo);
    session.promptBarWindowId = bar.windowId;
    session.promptBarTabId = bar.tabId;
    const ids = await getManagedWindowIds();
    ids.add(bar.windowId);
    await setManagedWindowIds(ids);
  } else if (!withBar && barId != null) {
    try { await chrome.windows.remove(barId); } catch (e) { /* already gone */ }
    await removeManagedWindowId(barId);
    session.promptBarWindowId = null;
    session.promptBarTabId = null;
  } else {
    session.promptBarWindowId = barId; // keep whatever's live (or null)
  }
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

function updateBookmarkUrl(id, url) {
  return new Promise((resolve) => {
    chrome.bookmarks.update(id, { url: url }, () => resolve(void chrome.runtime.lastError));
  });
}

function removeBookmarkNode(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.remove(id, () => resolve(void chrome.runtime.lastError));
  });
}

function getSubTree(id) {
  return new Promise((resolve) => chrome.bookmarks.getSubTree(id, (r) => resolve(r)));
}

// All bookkeeping (meta) bookmarks in a folder, parsed and ordered by seq.
function collectMetaBookmarks(children) {
  return (children || [])
    .filter(c => c.url && isMetaBookmarkUrl(c.url))
    .map(c => ({ id: c.id, data: parseMetaUrl(c.url) || {} }))
    .sort((a, b) => (a.data.seq || 0) - (b.data.seq || 0));
}

// Merge a session's sequenced meta bookmarks back into one record: order and
// custom title come from the primary (seq 0); turns are concatenated in seq
// order.
function mergeMeta(metas) {
  let order = null, customTitle = '', turns = [];
  for (const m of metas) {
    if (!order && Array.isArray(m.data.order) && m.data.order.length) order = m.data.order;
    if (!customTitle && m.data.customTitle) customTitle = m.data.customTitle;
    if (Array.isArray(m.data.turns)) turns = turns.concat(m.data.turns);
  }
  return { order: order, customTitle: customTitle, turns: turns };
}

function metaTitleForSeq(seq) {
  return seq === 0 ? META_TITLE : `${META_TITLE} -${String(seq + 1).padStart(2, '0')}`;
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
    const sub = await getSubTree(session.folderId);
    if (!sub || !sub[0]) return;
    const metas = collectMetaBookmarks(sub[0].children);

    // Preserve a user-set custom title carried on the existing primary.
    const customTitle = metas.length ? (metas[0].data.customTitle || '') : '';
    const payloads = chunkSessionMeta(session.order, customTitle, session.ledger);

    // Reconcile bookmarks to payloads: update existing in seq order, create any
    // additional chunks, delete any now-surplus ones.
    for (let i = 0; i < payloads.length; i++) {
      const url = encodeMetaUrl(payloads[i]);
      if (i < metas.length) {
        await updateBookmarkUrl(metas[i].id, url);
      } else {
        const bm = await createBookmark(session.folderId, metaTitleForSeq(i), url);
        if (i === 0) session.metaBookmarkId = bm.id;
      }
    }
    for (let i = payloads.length; i < metas.length; i++) {
      await removeBookmarkNode(metas[i].id);
    }
    if (metas.length) session.metaBookmarkId = metas[0].id;
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
      const children = folder.children || [];
      const models = children
        .filter(c => c.url && !isMetaBookmarkUrl(c.url))
        .map(c => modelForUrl(c.url))
        .filter(Boolean);
      const metas = collectMetaBookmarks(children);
      const customTitle = metas.length ? (metas[0].data.customTitle || '') : '';
      return { folderId: folder.id, title: folder.title, models: models, customTitle: customTitle };
    });
    return sessions.reverse(); // newest first
  },

  async renameSession(folderId, customTitle) {
    const sub = await getSubTree(folderId);
    if (!sub || !sub[0]) throw new Error("Session folder not found.");
    const metas = collectMetaBookmarks(sub[0].children);
    if (metas.length) {
      // Rewrite only the primary (seq 0); its turn chunk is preserved.
      const data = metas[0].data || { v: 1, seq: 0, order: [], turns: [] };
      data.seq = 0;
      if (customTitle) data.customTitle = customTitle; else delete data.customTitle;
      await updateBookmarkUrl(metas[0].id, buildMetaUrl(data));
    } else if (customTitle) {
      // No meta record yet — create the primary carrying just the custom title.
      // The next saveMeta() fills in order/turns and preserves this title.
      await createBookmark(folderId, META_TITLE,
        buildMetaUrl({ v: 1, seq: 0, order: [], turns: [], customTitle: customTitle }));
    }
  },

  async loadSession(folderId) {
    const sub = await getSubTree(folderId);
    if (!sub || !sub[0]) throw new Error("Session folder not found.");
    const children = sub[0].children || [];

    const bookmarks = {};
    const urls = {};
    for (const child of children) {
      if (!child.url || isMetaBookmarkUrl(child.url)) continue;
      const model = modelForUrl(child.url);
      if (model) { bookmarks[model] = child.id; urls[model] = child.url; }
    }

    const metas = collectMetaBookmarks(children);
    const merged = mergeMeta(metas);
    const order = (merged.order && merged.order.length)
      ? merged.order.filter(m => urls[m])
      : Object.keys(urls);
    return {
      order: order, turns: merged.turns, urls: urls, bookmarks: bookmarks,
      metaBookmarkId: metas.length ? metas[0].id : null
    };
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
      models: (rec.order && rec.order.length) ? rec.order : Object.keys(rec.urls || {}),
      customTitle: rec.customTitle || ''
    }));
  },

  async renameSession(id, customTitle) {
    const map = await localLoadSessions();
    const rec = map[id];
    if (!rec) return;
    if (customTitle) rec.customTitle = customTitle; else delete rec.customTitle;
    await localStoreSessions(map);
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
// one. Writes are chained through `ledgerWriteChain` so two near-simultaneous
// broadcasts can't interleave the get→push→set sequence and drop an entry.
let ledgerWriteChain = Promise.resolve();

function recordLedgerTurn(turnId, prompt) {
  ledgerWriteChain = ledgerWriteChain
    .then(() => doRecordLedgerTurn(turnId, prompt))
    .catch((e) => console.warn("Could not record ledger turn:", e));
  return ledgerWriteChain;
}

async function doRecordLedgerTurn(turnId, prompt) {
  const session = await getActiveSession();
  if (!session) return;
  // Private/temporary chats are deliberately never saved: their conversation
  // URLs are ephemeral, so a saved session could never be reopened anyway.
  if (session.private) return;
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

// Whether new chats should start in the sites' private/temporary mode
// (popup checkbox). Read at launch time, not stored on long-lived state, so
// flipping the checkbox always affects the NEXT New Chat.
async function getPrivateChatPref() {
  const { privateChatPref } = await chrome.storage.local.get(['privateChatPref']);
  return !!privateChatPref;
}

async function handleNewChat(models, screenInfo, withBar) {
  try {
    const n = models.length;
    if (n === 0) return;

    const privateMode = await getPrivateChatPref();
    const session = await getActiveSession();
    if (session && await sessionWindowsMatch(session, models)) {
      // Reuse the existing tiled windows: re-tile (leaving room for the bar when
      // wanted), start a fresh chat in each.
      const tScreen = tileScreen(screenInfo, withBar);
      for (let i = 0; i < n; i++) {
        await chrome.windows.update(session.windows[models[i]], {
          state: "normal", focused: true, ...computeGeom(tScreen, i, n)
        });
      }
      await sendActionToTabs(models, 'new_chat');
      await rotateSession(session, models, privateMode); // carries the bar over
      const next = await getActiveSession();
      await ensurePromptBar(next, screenInfo, withBar);
      await setActiveSession(next);
      await positionPromptBar(next.promptBarWindowId, screenInfo);
      // Show the in-page panel button only when there's no bar to host it.
      notifyManagedButtons(next);
      // After the in-page New Chat lands on the fresh launcher, click each
      // site's private toggle (the content script polls for the button, so the
      // SPA navigation racing this message is fine).
      if (privateMode) await sendActionToTabs(models, 'enter_private_chat');
    } else {
      // Nothing usable open: tile fresh windows and start a new session.
      await startFreshSession(models, screenInfo, privateMode, withBar);
    }
  } catch (err) {
    console.error("Failed to start new chat:", err);
  }
}

// Start a brand new (unsaved) active session for the conversations now living in
// the given windows (reused from the previous session), leaving the old session
// saved. The durable record is created lazily on the first prompt.
async function rotateSession(session, models, privateMode) {
  const next = {
    folderId: null,
    metaBookmarkId: null,
    order: models.slice(),
    windows: session.windows,
    tabs: session.tabs,
    bookmarks: {},
    ledger: [],
    private: !!privateMode,
    // Carry the live prompt bar across the rotation (ensurePromptBar reconciles).
    promptBarWindowId: session.promptBarWindowId || null,
    promptBarTabId: session.promptBarTabId || null
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
async function startFreshSession(models, screenInfo, privateMode, withBar) {
  await closeTiledWindows();

  const tScreen = tileScreen(screenInfo, withBar);
  const { windows, tabs, managed } = await openTiledWindows(models, (m) => AI_URLS[m], tScreen);
  const session = {
    folderId: null,
    metaBookmarkId: null,
    order: models.slice(),
    windows: windows,
    tabs: tabs,
    bookmarks: {},
    ledger: [],
    private: !!privateMode,
    promptBarWindowId: null,
    promptBarTabId: null
  };

  // Open the bar (added to the managed set so it broadcasts and tears down with
  // the session) before storing the managed ids.
  if (withBar) {
    const bar = await createPromptBar(screenInfo);
    session.promptBarWindowId = bar.windowId;
    session.promptBarTabId = bar.tabId;
    managed.add(bar.windowId);
  }

  await setManagedWindowIds(managed);
  await setActiveSession(session);

  // Proactively show the in-page button in each managed window. Fresh launcher
  // pages load fast and may have queried query_managed before the ids above were
  // stored, so don't rely on that poll alone.
  notifyManagedButtons(session);

  // Click each site's private/temporary toggle as soon as its content script
  // answers (sendWhenReady retries while the launcher is still loading).
  if (privateMode) {
    for (const model of Object.keys(tabs)) {
      if (tabs[model] != null) sendWhenReady(tabs[model], { action: 'enter_private_chat' });
    }
  }

  await tileWindows(models.map((m) => windows[m]), tScreen);
  await positionPromptBar(session.promptBarWindowId, screenInfo);
}

// Reconcile each chatbot tab's in-page floating panel button, retrying until
// the content script is ready. When the session has a shared prompt bar, the
// bar hosts the panel button, so the in-page one is hidden instead of shown.
function notifyManagedButtons(session) {
  const action = (session && session.promptBarWindowId)
    ? 'hide_managed_button' : 'show_managed_button';
  for (const model of Object.keys(session.tabs || {})) {
    const tabId = session.tabs[model];
    if (tabId != null) sendWhenReady(tabId, { action: action });
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

// Close any standalone popup.html window opened as the panel fallback (Safari,
// and any browser where action.openPopup is unavailable). Matches the same URL
// openPopupWindow uses to find/reuse it. A no-op when the panel is the toolbar
// popup (Chrome), since that isn't a window in windows.getAll.
async function closeStandalonePopupWindows() {
  const url = chrome.runtime.getURL('popup.html');
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.tabs && w.tabs.some(t => t.url && t.url.split('#')[0] === url)) {
        try { await chrome.windows.remove(w.id); } catch (e) { /* already gone */ }
      }
    }
  } catch (e) { /* best effort */ }
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
      // Only consider tabs in managed windows: a stray, unmanaged chatbot tab
      // that happens to come first in the tab list must not shadow the tiled one.
      const tab = allTabs.find(t => tabMatchesModel(t, model) && managedIds.has(t.windowId));
      if (tab) {
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

// --- Shared prompt bar (Tiled Windows) messaging ---------------------------

// Which of the active session's models still have a live tiled window (so the
// bar can light its connection dots), plus whether the session has gone private.
async function promptbarStatus() {
  const session = await getActiveSession();
  if (!session) return { status: 'success', order: [], connected: [], private: false };
  const managedIds = await getManagedWindowIds();
  const allTabs = await chrome.tabs.query({});
  const order = session.order || [];
  const connected = order.filter(model =>
    allTabs.some(t => tabMatchesModel(t, model) && managedIds.has(t.windowId)));
  return { status: 'success', order: order, connected: connected, private: !!session.private };
}

// The bar's Private button: switch every tiled window to its site's private/
// temporary mode and mark the session private so it's no longer persisted
// (doRecordLedgerTurn skips private sessions). Mirrors privatizeWorkspaceTab.
async function promptbarPrivate() {
  const session = await getActiveSession();
  if (!session) throw new Error('No active tiled session.');
  const models = session.order || [];
  if (!models.length) throw new Error('No chatbots in this session.');

  session.private = true;
  await setActiveSession(session);

  const managedIds = await getManagedWindowIds();
  const allTabs = await chrome.tabs.query({});
  const results = await Promise.all(models.map((model) => new Promise((resolve) => {
    const tab = allTabs.find(t => tabMatchesModel(t, model) && managedIds.has(t.windowId));
    if (!tab) { resolve({ model: model, ok: false }); return; }
    chrome.tabs.sendMessage(tab.id, { action: 'enter_private_chat' }, (response) => {
      void chrome.runtime.lastError;
      resolve({ model: model, ok: !!(response && response.success) });
    });
  })));
  return { status: 'success', results: results };
}

// A managed tiled window reported whether its injected prompt rendered. Forward
// it to the session's prompt bar for that model's delivery badge.
async function forwardTiledResult(model, ok, sender) {
  if (!sender || !sender.tab) return;
  const session = await getActiveSession();
  if (!session || session.promptBarTabId == null) return;
  const managedIds = await getManagedWindowIds();
  if (!managedIds.has(sender.tab.windowId)) return;
  chrome.tabs.sendMessage(
    session.promptBarTabId,
    { action: 'promptbar_pane_result', model: model, ok: ok },
    () => void chrome.runtime.lastError
  );
}

// --- Export ----------------------------------------------------------------

// Pick the workspace whose chats an export should capture: the workspace tab
// that is currently active in the last-focused window, if any. (Opening the
// popup doesn't change the active tab, so this is the workspace the user was
// just looking at.) Returns null when no workspace tab is in front.
async function activeWorkspaceForExport() {
  const map = await getWorkspaces();
  if (!Object.keys(map).length) return null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab && map[activeTab.id]) return map[activeTab.id];
  } catch (e) { /* fall through */ }
  return null;
}

// Ask one content script (a managed tab, or a workspace pane via frameId) for
// its chat history. Resolves to the history array, or [] if the script is gone
// or reports failure.
function extractHistory(tabId, frameId) {
  return new Promise((resolve) => {
    const handle = (res) => resolve((!chrome.runtime.lastError && res && res.success) ? res.history : []);
    if (frameId != null) {
      chrome.tabs.sendMessage(tabId, { action: 'extract_chat_history' }, { frameId: frameId }, handle);
    } else {
      chrome.tabs.sendMessage(tabId, { action: 'extract_chat_history' }, handle);
    }
  });
}

async function handleExport(models) {
  const allTabs = await chrome.tabs.query({});
  const managedWindowIds = await getManagedWindowIds();
  // With multiple workspaces possible, export the one the user is looking at:
  // the active tab in the last-focused window (the popup doesn't steal that).
  const workspace = await activeWorkspaceForExport();
  const results = {};

  for (const model of models) {
    // A workspace pane (chatbots live in frames of the extension tab, invisible
    // to the hostname/tab matching) takes precedence over a managed window.
    const frame = workspace && workspace.frames && workspace.frames[model];
    if (frame) {
      results[model] = await extractHistory(frame.tabId, frame.frameId);
      continue;
    }
    // Safari only (Chrome's behaviour is untouched): fall back to any open
    // chatbot tab when the managed-window lookup misses — Safari's window
    // bookkeeping is less reliable (window reopened by hand, background
    // restarted with the in-memory storage.session shim, …) and previously
    // that model was silently exported empty. frameId 0 pins extraction to the
    // top-level page so a same-host subframe can never answer first with [].
    const tab = allTabs.find(t => tabMatchesModel(t, model) && managedWindowIds.has(t.windowId)) ||
                (IS_SAFARI_EXTENSION ? allTabs.find(t => tabMatchesModel(t, model)) : null);
    results[model] = tab ? await extractHistory(tab.id, IS_SAFARI_EXTENSION ? 0 : undefined) : [];
  }
  return results;
}

// --- Saved sessions (picker) -----------------------------------------------

async function listSessions() {
  return await sessionRepo.listSessions();
}

// Keep only the chatbots currently selected in the popup. Used when reopening a
// saved session so a model the user has since deselected gets no window/pane.
// Falls back to the full set if the user has deselected everything in it.
async function filterToSelected(order) {
  const { selectedModels } = await chrome.storage.local.get(['selectedModels']);
  if (!Array.isArray(selectedModels) || !selectedModels.length) return order;
  const sel = new Set(selectedModels);
  const kept = order.filter(m => sel.has(m));
  return kept.length ? kept : order;
}

async function openSession(folderId, screenInfo, withBar) {
  const loaded = await sessionRepo.loadSession(folderId);
  const order = await filterToSelected(loaded.order);
  if (!order || order.length === 0) throw new Error("No chatbots saved in this session.");

  await closeTiledWindows();

  const tScreen = tileScreen(screenInfo, withBar);
  const { windows, tabs, managed } = await openTiledWindows(
    order, (m) => loaded.urls[m] || AI_URLS[m], tScreen);
  const session = {
    folderId: folderId,
    metaBookmarkId: loaded.metaBookmarkId || null,
    order: order.slice(),
    windows: windows,
    tabs: tabs,
    bookmarks: loaded.bookmarks || {},
    ledger: Array.isArray(loaded.turns) ? loaded.turns : [],
    promptBarWindowId: null,
    promptBarTabId: null
  };

  if (withBar) {
    const bar = await createPromptBar(screenInfo);
    session.promptBarWindowId = bar.windowId;
    session.promptBarTabId = bar.tabId;
    managed.add(bar.windowId);
  }

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

  await tileWindows(order.map((m) => windows[m]), tScreen);
  await positionPromptBar(session.promptBarWindowId, screenInfo);
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

// Set (or clear, when title is empty) a user-friendly display name for a saved
// session. The original timestamp title is left untouched for internal ordering;
// this custom name only overrides what the popup shows.
async function renameSession(folderId, title) {
  await sessionRepo.renameSession(folderId, (title || '').trim());
}

// --- Iframe workspace (EXPERIMENTAL SPIKE) ----------------------------------
//
// An extension page (workspace.html) embeds the chatbots in side-by-side
// iframes with one shared prompt box. The sites forbid framing via
// X-Frame-Options / CSP frame-ancestors, so while the workspace tab is open we
// install a *session* declarativeNetRequest rule — scoped to exactly that tab
// and to sub_frame loads — that strips those headers.
//
// The list includes two service hosts the chatbots frame *within themselves*:
// accounts.google.com (Gemini's session-cookie rotation frame) and a.claude.ai
// (Claude's sandboxed segment). Their frame-ancestors checks walk the whole
// ancestor chain, which now contains our extension origin, so without this
// they get blocked — observed as Gemini failing to rotate its session inside
// the workspace. The rule being session-only, sub_frame-only, and pinned to
// the workspace tab keeps the clickjacking exposure contained; a full Google
// sign-in inside a pane is still expected to fail (Google also blocks embedded
// logins in JS) — sign in via a normal tab instead.
//
// Known trade-off: DNR can only remove whole headers, not edit values, so the
// framed site's entire CSP — including its own XSS protections — is dropped
// inside the panes. Acceptable for this experiment; revisit before shipping.

const WORKSPACE_RULE_ID = 7001;
const WORKSPACE_PROBE_RULE_ID = 7002;
const WORKSPACE_DOMAINS = [
  'gemini.google.com', 'claude.ai', 'chatgpt.com',
  'accounts.google.com', 'a.claude.ai'
];

// What this browser's declarativeNetRequest can actually do for the workspace:
//   'tab-scoped' — response-header removal with per-tab (tabIds) scoping: Chrome.
//   'global'     — header removal works but only browser-wide (Firefox has no
//                  tabIds condition); the rule still exists only while at least
//                  one workspace tab is open, so exposure stays bounded.
//   'none'       — response headers cannot be removed at all (Safari,
//                  https://webkit.org/b/275158): the workspace cannot work.
// Detected once per service-worker life by installing a throwaway session rule
// against a non-routable probe domain and reading it back — reading back
// catches browsers that silently drop the unsupported parts instead of
// rejecting the rule.
let workspaceRuleSupport = null;

function workspaceProbeRule(withTabIds) {
  const rule = {
    id: WORKSPACE_PROBE_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' }
      ]
    },
    condition: {
      requestDomains: ['multi-prompt-capability-probe.invalid'],
      resourceTypes: ['sub_frame']
    }
  };
  if (withTabIds) rule.condition.tabIds = [999999999];
  return rule;
}

async function probeRuleSticks(withTabIds) {
  const dnr = chrome.declarativeNetRequest;
  await dnr.updateSessionRules({
    removeRuleIds: [WORKSPACE_PROBE_RULE_ID],
    addRules: [workspaceProbeRule(withTabIds)]
  });
  const rules = await dnr.getSessionRules();
  const rule = rules.find(r => r.id === WORKSPACE_PROBE_RULE_ID);
  return !!(rule &&
    rule.action && Array.isArray(rule.action.responseHeaders) &&
    rule.action.responseHeaders.length === 2 &&
    (!withTabIds || (rule.condition && Array.isArray(rule.condition.tabIds))));
}

async function detectWorkspaceRuleSupport() {
  if (workspaceRuleSupport) return workspaceRuleSupport;
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || typeof dnr.updateSessionRules !== 'function' ||
      typeof dnr.getSessionRules !== 'function') {
    workspaceRuleSupport = 'none';
    return workspaceRuleSupport;
  }
  // Chromium implements the full surface (tab-scoped session rules with
  // response-header removal), so skip the probe there entirely — Chrome's
  // behaviour and session-rule state stay exactly as they always were.
  if (typeof location !== 'undefined' && location.protocol === 'chrome-extension:') {
    workspaceRuleSupport = 'tab-scoped';
    return workspaceRuleSupport;
  }
  try {
    workspaceRuleSupport = (await probeRuleSticks(true)) ? 'tab-scoped' : 'none';
  } catch (e) {
    try {
      workspaceRuleSupport = (await probeRuleSticks(false)) ? 'global' : 'none';
    } catch (e2) {
      workspaceRuleSupport = 'none';
    }
  }
  try {
    await dnr.updateSessionRules({ removeRuleIds: [WORKSPACE_PROBE_RULE_ID] });
  } catch (e) { /* probe rule never installed */ }
  return workspaceRuleSupport;
}

// Workspaces are keyed by their tab id, so any number can be open at once —
// each a tab of iframes with its own shared prompt box that broadcasts only to
// the panes in that same tab. A single declarativeNetRequest rule (header
// stripping) covers all open workspace tabs via its tabIds list. One entry:
//   { frames:{model->{tabId,frameId}}, urls:{}, turns:[], reattached:{}, navigated:{} }
async function getWorkspaces() {
  const r = await sessionStore.get(['workspaces']);
  return r.workspaces || {};
}

async function getWorkspaceForTab(tabId) {
  const map = await getWorkspaces();
  return map[tabId] || null;
}

// Serialise workspace-map writes: all three frames of a tab hello at the same
// moment on load (and several tabs may be doing so at once), so an interleaved
// read-modify-write would silently drop a pane from the registry.
let workspaceWriteChain = Promise.resolve();

function withWorkspaces(mutate) {
  workspaceWriteChain = workspaceWriteChain.then(async () => {
    const map = await getWorkspaces();
    mutate(map);
    await sessionStore.set({ workspaces: map });
  }).catch((e) => console.warn('Workspace state update failed:', e));
  return workspaceWriteChain;
}

// Re-derive the header-stripping rule's tab scope from the set of open
// workspace tabs. Called whenever a workspace tab opens or closes.
async function syncWorkspaceRules() {
  const map = await getWorkspaces();
  const tabIds = Object.keys(map).map(Number);
  if (!tabIds.length) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [WORKSPACE_RULE_ID] });
    } catch (e) { /* rule already gone */ }
    return;
  }
  const support = await detectWorkspaceRuleSupport();
  if (support === 'none') return; // openWorkspace already refused; nothing to install
  const condition = {
    requestDomains: WORKSPACE_DOMAINS,
    resourceTypes: ['sub_frame']
  };
  if (support === 'tab-scoped') condition.tabIds = tabIds;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [WORKSPACE_RULE_ID],
    addRules: [{
      id: WORKSPACE_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ]
      },
      condition: condition
    }]
  });
}

const WORKSPACE_UNSUPPORTED_MESSAGE =
  'This browser cannot remove the response headers (X-Frame-Options / ' +
  'Content-Security-Policy) that block embedding the chatbots in iframes — ' +
  'Safari does not support this — so Tiled in a Tab is unavailable here. ' +
  'Use the regular tiled-windows mode instead.';

// Open a NEW workspace tab. `folderId` is a saved session to reopen, or null
// for a fresh chat; it travels in the URL hash so each tab is self-describing
// (no shared "pending target" to race when several are opened at once).
async function openWorkspace(folderId) {
  if ((await detectWorkspaceRuleSupport()) === 'none') {
    throw new Error(WORKSPACE_UNSUPPORTED_MESSAGE);
  }
  const hash = folderId ? '#session=' + encodeURIComponent(folderId) : '';
  await chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') + hash });
}

// The workspace page announcing itself: register its tab, scope the header
// rules to include it, and hand back which panes to create. A fresh chat uses
// the selected models at their launcher URLs; reopening a saved session
// (folderId from the page's hash) uses that session's saved per-model
// conversation URLs and carries its turn ledger for re-stamping.
async function initWorkspace(sender, folderId) {
  if (!sender || !sender.tab) throw new Error('Workspace tab not identified.');
  // Re-checked here (openWorkspace already refused) so a workspace.html opened
  // or reloaded directly in an unsupported browser shows the notice instead of
  // a row of dead iframes.
  if ((await detectWorkspaceRuleSupport()) === 'none') {
    throw new Error(WORKSPACE_UNSUPPORTED_MESSAGE);
  }
  const tabId = sender.tab.id;

  let order, urls, turns = [];
  let sessionFolderId = null, bookmarks = {}, metaBookmarkId = null;
  // Fresh chats honour the popup's private-chat checkbox; reopened saved
  // sessions never auto-privatize (they are existing, non-private chats).
  let privateMode = false;
  if (folderId) {
    const loaded = await sessionRepo.loadSession(folderId);
    order = await filterToSelected(loaded.order);
    if (!order || !order.length) throw new Error('No chatbots saved in this session.');
    urls = {};
    for (const m of order) urls[m] = loaded.urls[m] || AI_URLS[m];
    turns = Array.isArray(loaded.turns) ? loaded.turns : [];
    // New prompts in this tab append to the same saved session.
    sessionFolderId = folderId;
    bookmarks = loaded.bookmarks || {};
    metaBookmarkId = loaded.metaBookmarkId || null;
  } else {
    const { selectedModels } = await chrome.storage.local.get(['selectedModels']);
    order = (Array.isArray(selectedModels) && selectedModels.length)
      ? selectedModels.filter(m => AI_URLS[m])
      : Object.keys(AI_URLS);
    urls = {};
    for (const m of order) urls[m] = AI_URLS[m];
    privateMode = await getPrivateChatPref();
  }

  // Register the tab (order + seeded urls so reloaded panes restore, turns for
  // re-stamp, and the session handles so prompts persist), then extend the
  // header rule to cover it — all before the page creates any iframe (it only
  // does so after this returns).
  await withWorkspaces((map) => {
    map[tabId] = {
      order: order.slice(), frames: {}, urls: { ...urls }, turns: turns,
      reattached: {}, navigated: {}, privatized: {}, framePrivate: {},
      privateMode: privateMode,
      folderId: sessionFolderId, bookmarks: bookmarks, metaBookmarkId: metaBookmarkId
    };
  });
  await syncWorkspaceRules();
  return { order: order, urls: urls };
}

async function registerWorkspaceFrame(model, sender, framePrivate) {
  if (!model || !sender || !sender.tab || sender.frameId == null) return {};
  const tabId = sender.tab.id;
  const map = await getWorkspaces();
  const entry = map[tabId];
  if (!entry) return {}; // not a frame inside a known workspace tab

  // Hellos arrive as a heartbeat; only act when the registration changed.
  const existing = entry.frames && entry.frames[model];
  if (!existing || existing.frameId !== sender.frameId) {
    await withWorkspaces((m) => {
      if (!m[tabId]) return;
      m[tabId].frames[model] = { tabId: tabId, frameId: sender.frameId };
    });

    // Private workspace: switch the pane to the site's private/temporary mode
    // as soon as its frame registers. Once per frame instance (gated like
    // reattach below) — the in-page toggle must never be clicked twice.
    const alreadyPrivatized = entry.privatized && entry.privatized[model] === sender.frameId;
    if (entry.privateMode && !alreadyPrivatized) {
      chrome.tabs.sendMessage(
        tabId,
        { action: 'enter_private_chat' },
        { frameId: sender.frameId },
        () => void chrome.runtime.lastError
      );
      await withWorkspaces((m) => {
        if (!m[tabId]) return;
        m[tabId].privatized = m[tabId].privatized || {};
        m[tabId].privatized[model] = sender.frameId;
      });
    }

    // Reopened saved session: re-stamp this pane's reloaded turns with their
    // original ids so export alignment survives. Once per frame instance.
    const turns = entry.turns || [];
    const alreadyReattached = entry.reattached && entry.reattached[model] === sender.frameId;
    if (turns.length && !alreadyReattached) {
      chrome.tabs.sendMessage(
        tabId,
        { action: 'reattach_turns', turns: turns },
        { frameId: sender.frameId },
        () => void chrome.runtime.lastError
      );
      await withWorkspaces((m) => {
        if (!m[tabId]) return;
        m[tabId].reattached = m[tabId].reattached || {};
        m[tabId].reattached[model] = sender.frameId;
      });
    }
  }

  // Track each pane's live private state (reported with every hello) for the
  // workspace UI's titlebar ghost indicators. Written only on change — hellos
  // arrive every 2s per pane.
  const knownPrivate = !!(entry.framePrivate && entry.framePrivate[model]);
  if (knownPrivate !== !!framePrivate) {
    await withWorkspaces((m) => {
      if (!m[tabId]) return;
      m[tabId].framePrivate = m[tabId].framePrivate || {};
      m[tabId].framePrivate[model] = !!framePrivate;
    });
  }

  // A spontaneous frame reload reverts the pane to the iframe's original src
  // (the blank launcher), abandoning the conversation. If this pane has a real
  // conversation permalink on record, steer it back there — but defensively:
  //   • the saved URL must itself be a stable conversation URL, so a fresh chat
  //     (whose saved URL is the launcher) is never told to "restore" to the
  //     launcher on every heartbeat,
  //   • we steer to a given URL at most once, so a conversation URL that won't
  //     "stick" (keeps bouncing to the launcher) can't drive a reload loop, and
  //   • the pane must have *stayed* on the launcher across a couple of heartbeats
  //     before we act. Sending the first prompt naturally transits launcher →
  //     conversation, and that new permalink IS the saved URL; a single transient
  //     launcher reading during that hand-off (or Gemini's first-message reload)
  //     would otherwise yank the page and reset the answer mid-stream. A genuine
  //     reload leaves the pane parked on the launcher, so it lingers here; a
  //     hand-off clears within one tick.
  // Reload loops here trip the sites' bot-detection (observed: Gemini CAPTCHA).
  const STEER_DWELL_MS = 5000;
  const savedUrl = entry.urls && entry.urls[model];
  const alreadySteered = entry.navigated && entry.navigated[model] === savedUrl;
  const onLauncher = sender.url && sender.url !== savedUrl &&
    !isStableConversationUrl(model, sender.url);
  const restorable = savedUrl && !alreadySteered &&
    isStableConversationUrl(model, savedUrl) && onLauncher;

  if (restorable) {
    const since = entry.launcherSince && entry.launcherSince[model];
    const now = Date.now();
    if (!since) {
      // First heartbeat seeing the launcher — start the dwell timer, don't act.
      await withWorkspaces((m) => {
        if (!m[tabId]) return;
        m[tabId].launcherSince = m[tabId].launcherSince || {};
        m[tabId].launcherSince[model] = now;
      });
      return {};
    }
    if (now - since < STEER_DWELL_MS) return {}; // still inside the grace window
    await withWorkspaces((m) => {
      if (!m[tabId]) return;
      m[tabId].navigated = m[tabId].navigated || {};
      m[tabId].navigated[model] = savedUrl;
      if (m[tabId].launcherSince) delete m[tabId].launcherSince[model];
    });
    return { navigate: savedUrl };
  }

  // Healthy (or nothing to restore yet): clear any pending dwell timer so a
  // future genuine reload starts its grace window fresh.
  if (entry.launcherSince && entry.launcherSince[model]) {
    await withWorkspaces((m) => {
      if (m[tabId] && m[tabId].launcherSince) delete m[tabId].launcherSince[model];
    });
  }
  return {};
}

// A workspace pane reporting a stable conversation permalink (via the
// session_url messages content scripts already send). Recorded so a reloaded
// pane can be steered back to its conversation.
async function captureWorkspaceUrl(url, sender) {
  const model = modelForUrl(url);
  if (!model || !isStableConversationUrl(model, url)) return;
  if (!sender || !sender.tab) return;
  const tabId = sender.tab.id;
  const map = await getWorkspaces();
  const entry = map[tabId];
  if (!entry) return;
  // A private tab records nothing: no URL capture (private permalinks are
  // ephemeral) and — for a reopened saved session switched to private — its
  // bookmarks must keep pointing at the original, pre-private conversation.
  if (entry.privateMode) return;
  const frame = entry.frames && entry.frames[model];
  if (!frame || frame.frameId !== sender.frameId) return;
  // Update the in-memory url only when it changed (drives reload-restore), but
  // still persist below on every stable report: the session may be created (by
  // the first prompt) AFTER the first URL report, and the content script only
  // re-reports a URL a handful of times — so a dedup-and-return here could leave
  // the bookmark stuck on the launcher URL.
  if (!(entry.urls && entry.urls[model] === url)) {
    await withWorkspaces((m) => {
      if (!m[tabId]) return;
      m[tabId].urls = m[tabId].urls || {};
      m[tabId].urls[model] = url;
    });
  }

  // If this tab's chat is already a saved session, point its per-model bookmark
  // at the live conversation permalink (so reopening resumes the real chat).
  if (entry.folderId && entry.bookmarks && entry.bookmarks[model]) {
    try {
      await sessionRepo.setModelUrl(
        { folderId: entry.folderId, bookmarks: entry.bookmarks }, model, url);
    } catch (e) {
      console.warn('Could not update saved workspace URL:', e);
    }
  }
}

// Deliver a message to one workspace frame, retrying briefly (the pane may be
// mid-reload, with no content script listening yet). Resolves to whether the
// frame actually acknowledged it.
function sendToFrameWithRetry(frame, message) {
  return new Promise((resolve) => {
    const attempt = (n) => {
      chrome.tabs.sendMessage(frame.tabId, message, { frameId: frame.frameId }, (res) => {
        if (!chrome.runtime.lastError && res && res.success) {
          resolve(true);
          return;
        }
        if (n < 10) setTimeout(() => attempt(n + 1), 500); // ~5s of patience
        else resolve(false);
      });
    };
    attempt(0);
  });
}

// One workspace's shared prompt box → every pane in THAT tab (identified by the
// sender), with one shared turn id so export alignment works unchanged.
async function handleWorkspaceBroadcast(prompt, sender) {
  if (!sender || !sender.tab) return { status: 'error', error: 'Unknown workspace tab.' };
  const entry = await getWorkspaceForTab(sender.tab.id);
  const models = entry ? Object.keys(entry.frames || {}) : [];
  if (!models.length) {
    return { status: 'error', error: 'No chatbot panes are ready yet.' };
  }
  const turnId = generateTurnId();
  const results = await Promise.all(models.map(async (model) => ({
    model: model,
    delivered: await sendToFrameWithRetry(
      entry.frames[model],
      { action: 'inject_prompt', prompt: prompt, turnId: turnId }
    )
  })));
  const sent = results.filter(r => r.delivered).map(r => r.model);
  const failed = results.filter(r => !r.delivered).map(r => r.model);
  if (!sent.length) {
    return { status: 'error', error: 'No pane accepted the prompt (' + failed.join(', ') + ').' };
  }
  // Persist the turn so a Tiled-in-a-Tab chat is saved like a tiled one (the
  // first turn lazily creates the durable session record).
  persistWorkspaceTurn(sender.tab.id, turnId, prompt);
  return { status: 'success', turnId: turnId, models: sent, failed: failed };
}

// Switch every registered pane of the sender's workspace tab to the site's
// private/temporary chat mode (the bar's Private button). Marks the tab
// private first — stopping session persistence and the URL-restore steering
// (going private abandons any previous conversation by design) — then asks
// each frame to click its toggle, reporting per-model outcomes. The content
// script's page-lifetime guard makes repeat requests safe (the toggles are
// never clicked twice).
async function privatizeWorkspaceTab(sender) {
  if (!sender || !sender.tab) throw new Error('Unknown workspace tab.');
  const tabId = sender.tab.id;
  const entry = await getWorkspaceForTab(tabId);
  if (!entry) throw new Error('Workspace not registered.');
  const models = Object.keys(entry.frames || {});
  if (!models.length) throw new Error('No chatbot panes are ready yet.');

  await withWorkspaces((m) => {
    const e = m[tabId];
    if (!e) return;
    e.privateMode = true;
    e.navigated = e.navigated || {};
    for (const model of e.order || models) {
      if (e.urls && e.urls[model]) e.navigated[model] = e.urls[model];
    }
  });

  const results = await Promise.all(models.map((model) => new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { action: 'enter_private_chat' },
      { frameId: entry.frames[model].frameId },
      (response) => {
        void chrome.runtime.lastError;
        resolve({ model: model, ok: !!(response && response.success) });
      }
    );
  })));
  return { status: 'success', results: results };
}

// Record a workspace turn into its durable session, creating the record lazily
// on the first prompt (so a tab that's opened but never used saves nothing).
// Mirrors the tiled-mode recordLedgerTurn/ensureSessionPersisted path, but keyed
// to the workspace tab's entry. Serialised so concurrent turns and the folder's
// read-modify-write meta reconciliation can't interleave.
let workspacePersistChain = Promise.resolve();

function persistWorkspaceTurn(tabId, turnId, prompt) {
  workspacePersistChain = workspacePersistChain
    .then(() => doPersistWorkspaceTurn(tabId, turnId, prompt))
    .catch((e) => console.warn('Could not persist workspace turn:', e));
  return workspacePersistChain;
}

async function doPersistWorkspaceTurn(tabId, turnId, prompt) {
  const map = await getWorkspaces();
  const entry = map[tabId];
  if (!entry) return;
  // Private/temporary chats are deliberately never saved: their conversation
  // URLs are ephemeral, so a saved session could never be reopened anyway.
  if (entry.privateMode) return;

  const ledger = Array.isArray(entry.turns) ? entry.turns.slice() : [];
  ledger.push({ id: turnId, p: normalizePromptPrefix(prompt) });

  const session = {
    folderId: entry.folderId || null,
    order: entry.order || Object.keys(entry.frames || {}),
    ledger: ledger,
    bookmarks: entry.bookmarks || {},
    metaBookmarkId: entry.metaBookmarkId || null
  };

  if (!session.folderId) {
    // Lazily create the durable record from each pane's current URL.
    const urls = {};
    for (const m of session.order) urls[m] = (entry.urls && entry.urls[m]) || AI_URLS[m];
    await sessionRepo.createSession(session, session.order, urls);
  }
  await sessionRepo.saveMeta(session);

  // Store the ledger and any handles the repo set back onto the tab's entry.
  await withWorkspaces((m) => {
    if (!m[tabId]) return;
    m[tabId].turns = ledger;
    m[tabId].folderId = session.folderId;
    m[tabId].bookmarks = session.bookmarks;
    m[tabId].metaBookmarkId = session.metaBookmarkId;
  });
}

// Extract every pane's chat history for one workspace tab (its own Export
// button), keyed by model — same shape handleExport returns, so the shared
// alignment/markdown code in align.js consumes it unchanged.
async function exportWorkspaceTab(sender) {
  if (!sender || !sender.tab) throw new Error('Unknown workspace tab.');
  const entry = await getWorkspaceForTab(sender.tab.id);
  if (!entry) throw new Error('This workspace tab has no panes registered.');
  const results = {};
  for (const model of Object.keys(entry.frames || {})) {
    const frame = entry.frames[model];
    results[model] = await extractHistory(frame.tabId, frame.frameId);
  }
  return results;
}

// A pane reporting its injection outcome. Forward it only to ITS OWN workspace
// tab's prompt bar (runtime.sendMessage would otherwise broadcast to every open
// workspace page, crossing the wires between tabs).
async function forwardPaneResult(model, ok, sender) {
  if (!sender || !sender.tab) return;
  const entry = await getWorkspaceForTab(sender.tab.id);
  if (!entry) return;
  chrome.tabs.sendMessage(
    sender.tab.id,
    { action: 'workspace_pane_result', model: model, ok: ok },
    { frameId: 0 },
    () => void chrome.runtime.lastError
  );
}

// Closing a workspace tab drops its entry and re-scopes the header rule.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const map = await getWorkspaces();
  if (map[tabId]) {
    await withWorkspaces((m) => { delete m[tabId]; });
    await syncWorkspaceRules();
  }
});
