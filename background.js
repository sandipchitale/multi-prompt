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

// --- Managed window bookkeeping (storage.session) -------------------------

async function getManagedWindowIds() {
  const result = await chrome.storage.session.get(['managedWindowIds']);
  return new Set(result.managedWindowIds || []);
}

async function setManagedWindowIds(ids) {
  await chrome.storage.session.set({ managedWindowIds: Array.from(ids) });
}

async function removeManagedWindowId(windowId) {
  const ids = await getManagedWindowIds();
  ids.delete(windowId);
  await setManagedWindowIds(ids);
}

// --- Active session bookkeeping (storage.session) -------------------------
//
// The active session links the live tiled windows to their bookmark folder and
// carries the working copy of the turn-id ledger. The durable copy lives in the
// session's meta bookmark, so this can safely evaporate when the browser (and
// thus the windows) restarts.

async function getActiveSession() {
  const result = await chrome.storage.session.get(['activeSession']);
  return result.activeSession || null;
}

async function setActiveSession(session) {
  await chrome.storage.session.set({ activeSession: session });
}

async function clearActiveSession() {
  await chrome.storage.session.remove('activeSession');
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

// Keep a session's per-model bookmark pointed at the live conversation URL as it
// stabilises, so the saved session resumes the real chat rather than a blank one.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const session = await getActiveSession();
  if (!session || !session.tabs) return;
  const model = modelForUrl(changeInfo.url);
  if (!model || session.tabs[model] !== tabId) return;
  if (isStableConversationUrl(model, changeInfo.url) && session.bookmarks && session.bookmarks[model]) {
    chrome.bookmarks.update(session.bookmarks[model], { url: changeInfo.url },
      () => void chrome.runtime.lastError);
  }
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
    openActionPopup(sender);
    sendResponse({ status: 'ok' });
  }
});

async function isWindowManaged(sender) {
  if (!sender || !sender.tab) return false;
  const ids = await getManagedWindowIds();
  return ids.has(sender.tab.windowId);
}

async function openActionPopup(sender) {
  try {
    const windowId = sender && sender.tab ? sender.tab.windowId : undefined;
    await chrome.action.openPopup(windowId ? { windowId: windowId } : {});
  } catch (e) {
    console.warn("Could not open action popup:", e);
  }
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

async function createSessionFolder(parentId) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
             `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return await new Promise((resolve, reject) => {
    chrome.bookmarks.create({ parentId: parentId, title: `Session - ${ts}` }, (folder) => {
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

// Persist the session's order + ledger into its bookkeeping bookmark.
async function writeMeta(session) {
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
}

// Append one broadcast turn to the active session's ledger and persist it.
async function recordLedgerTurn(turnId, prompt) {
  const session = await getActiveSession();
  if (!session) return;
  session.ledger.push({ id: turnId, p: normalizePromptPrefix(prompt) });
  try {
    await writeMeta(session);
  } catch (e) {
    console.warn("Could not update session meta bookmark:", e);
  }
  await setActiveSession(session);
}

// --- New chat / tiling -----------------------------------------------------
//
// "New Chat" is the single entry point: if the selected models are already
// tiled it re-tiles them and starts a fresh chat in each; otherwise it opens
// fresh tiled windows (which begin on a blank chat). Either way it rotates to a
// brand new saved session.

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

// Open a brand new session folder for the conversations now living in the given
// windows (reused from the previous session), leaving the old folder saved.
async function rotateSession(session, models) {
  const parent = await ensureParentFolder();
  const folder = await createSessionFolder(parent.id);

  const next = {
    folderId: folder.id,
    metaBookmarkId: null,
    order: models.slice(),
    windows: session.windows,
    tabs: session.tabs,
    bookmarks: {},
    ledger: []
  };

  for (const model of models) {
    const bm = await createBookmark(folder.id, MODEL_TITLES[model], AI_URLS[model]);
    next.bookmarks[model] = bm.id;
  }

  await writeMeta(next);
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

// Open fresh chats for each model, tiled, and auto-create the session bookmark
// folder that will track them.
async function startFreshSession(models, screenInfo) {
  await closeTiledWindows();

  const parent = await ensureParentFolder();
  const folder = await createSessionFolder(parent.id);

  const session = {
    folderId: folder.id,
    metaBookmarkId: null,
    order: models.slice(),
    windows: {},
    tabs: {},
    bookmarks: {},
    ledger: []
  };

  const managed = new Set();
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const win = await createWindow(AI_URLS[model], computeGeom(screenInfo, i, models.length));
    const tab = win.tabs && win.tabs[0];
    session.windows[model] = win.id;
    session.tabs[model] = tab ? tab.id : null;
    managed.add(win.id);
    const bm = await createBookmark(folder.id, MODEL_TITLES[model], (tab && tab.url) || AI_URLS[model]);
    session.bookmarks[model] = bm.id;
  }

  await setManagedWindowIds(managed);
  await writeMeta(session);
  await setActiveSession(session);
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
      await writeMeta(session).catch(() => {});
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

    chrome.storage.local.get(['selectedModels'], async (result) => {
      const selected = result.selectedModels || ['gemini', 'claude', 'chatgpt'];
      const targetModels = selected.filter(m => m !== source);
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
    });
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
}

async function openSession(folderId, screenInfo) {
  const sub = await new Promise((resolve) => chrome.bookmarks.getSubTree(folderId, resolve));
  if (!sub || !sub[0]) throw new Error("Session folder not found.");
  const children = sub[0].children || [];

  let meta = null;
  let metaBookmarkId = null;
  const modelBookmarks = {};
  for (const child of children) {
    if (!child.url) continue;
    if (isMetaBookmarkUrl(child.url)) {
      meta = parseMetaUrl(child.url);
      metaBookmarkId = child.id;
      continue;
    }
    const model = modelForUrl(child.url);
    if (model) modelBookmarks[model] = { url: child.url, id: child.id };
  }

  let order = (meta && Array.isArray(meta.order))
    ? meta.order.filter(m => modelBookmarks[m])
    : Object.keys(modelBookmarks);
  if (order.length === 0) throw new Error("No chatbot bookmarks in this session.");

  await closeTiledWindows();

  const session = {
    folderId: folderId,
    metaBookmarkId: metaBookmarkId,
    order: order.slice(),
    windows: {},
    tabs: {},
    bookmarks: {},
    ledger: (meta && Array.isArray(meta.turns)) ? meta.turns : []
  };

  const managed = new Set();
  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    const win = await createWindow(modelBookmarks[model].url, computeGeom(screenInfo, i, order.length));
    const tab = win.tabs && win.tabs[0];
    session.windows[model] = win.id;
    session.tabs[model] = tab ? tab.id : null;
    session.bookmarks[model] = modelBookmarks[model].id;
    managed.add(win.id);

    // Re-stamp the reloaded turns with their original ids so alignment survives.
    if (tab && session.ledger.length) {
      sendWhenReady(tab.id, { action: 'reattach_turns', turns: session.ledger });
    }
  }

  await setManagedWindowIds(managed);
  await setActiveSession(session);
}

async function deleteSession(folderId) {
  await new Promise((resolve, reject) => {
    chrome.bookmarks.removeTree(folderId, () => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve();
    });
  });
  const session = await getActiveSession();
  if (session && session.folderId === folderId) {
    // The folder is gone; detach it from the live windows (which stay open).
    session.folderId = null;
    session.metaBookmarkId = null;
    session.bookmarks = {};
    await setActiveSession(session);
  }
}
