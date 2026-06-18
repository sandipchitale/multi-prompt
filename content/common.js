// Shared multi-prompt content-script logic.
//
// Each site script (claude.js, chatgpt.js, gemini.js) runs in the same
// isolated world as this file and calls MultiPrompt.init(config) with
// site-specific selectors and a newChat() routine. All of the cross-site
// behaviour (safe text injection, submission, echo-loop guarding and
// broadcast interception) lives here so it is defined exactly once.

(function () {
  // Verbose injection tracing (which insertion strategy ran, send clicks, turn
  // detection). Set true when debugging a pane that won't accept prompts; the
  // workspace status line (✓/✗ per pane) covers the day-to-day signal.
  const DEBUG = false;
  function dbg(...args) {
    if (DEBUG) console.info('[Multi-Prompt]', ...args);
  }

  // True while we are programmatically filling/submitting an editor, so the
  // broadcast interceptors below ignore the events our own injection produces.
  let isProgrammaticInput = false;

  // Per-page de-duplication so a single user submission is not broadcast twice
  // (e.g. by both the mousedown and click interceptors firing for one click).
  let lastBroadcastPrompt = '';
  let lastBroadcastTime = 0;

  // Attribute stamped onto each rendered user-message element so the same turn
  // can be matched exactly across all models at export time. It is added to the
  // DOM *after* the message is sent, so the model itself never sees it — no
  // prompt contamination, unlike embedding a marker in the prompt text.
  const TURN_ATTR = 'data-mp-turn';

  // Ordinal-indexed ledger of turn ids for THIS page: turnLedger[i] is the id of
  // the i-th user turn. We re-apply tags by POSITION rather than by element
  // reference, so they survive frameworks that replace the turn node on
  // re-render (notably Gemini/Angular, which silently dropped reference-based
  // tags). siteConfig is the config handed to init(), used to locate user turns.
  const turnLedger = [];
  let siteConfig = null;
  let turnObserver = null;
  let reconcileQueued = false;

  // True when this frame is a workspace pane root (a direct child of the
  // workspace page). Set in init(); used to report injection results.
  let isWorkspacePane = false;

  // When true, typing directly in this chatbot's own prompt box also broadcasts to
  // the other panes. Default false: a direct keystroke submits only here; the shared
  // prompt box is the way to send to all. Read from chrome.storage.local in init()
  // and kept live via storage.onChanged.
  let broadcastOnType = false;

  function getUserTurnEls() {
    if (!siteConfig || !siteConfig.userTurnSelector) return [];
    return Array.from(document.querySelectorAll(siteConfig.userTurnSelector));
  }

  // Ensure each rendered user turn carries the id recorded for its position.
  function reconcileTurnTags() {
    const els = getUserTurnEls();
    for (let i = 0; i < turnLedger.length; i++) {
      const id = turnLedger[i];
      const el = els[i];
      if (id && el && el.getAttribute(TURN_ATTR) !== id) {
        el.setAttribute(TURN_ATTR, id);
      }
    }
  }

  // Coalesce the many mutations a chat page emits (streaming responses, etc.)
  // into one reconcile per frame.
  function scheduleReconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    requestAnimationFrame(() => { reconcileQueued = false; reconcileTurnTags(); });
  }

  function ensureTurnObserver() {
    if (turnObserver) return;
    turnObserver = new MutationObserver(scheduleReconcile);
    turnObserver.observe(document.body, { childList: true, subtree: true });
  }

  // After a submission, wait for the new user turn to render, then record its id
  // at its ordinal position (it is the newest, hence last) and stamp it.
  // `onDone(rendered)` reports whether a new turn ever appeared — the ground
  // truth for "this prompt was actually sent".
  function tagNewUserTurn(turnId, beforeCount, onDone) {
    if (!turnId || !siteConfig || !siteConfig.userTurnSelector) {
      if (onDone) onDone(false);
      return;
    }
    let attempts = 0;

    const tryTag = () => {
      const els = getUserTurnEls();
      if (els.length > beforeCount) {
        turnLedger[els.length - 1] = turnId;
        reconcileTurnTags();
        ensureTurnObserver();
        // Confirm before reporting success: a transient node (optimistic render
        // that the site rolls back on error) can satisfy the count briefly.
        if (onDone) {
          setTimeout(() => onDone(getUserTurnEls().length > beforeCount), 1500);
        }
        return;
      }
      if (attempts++ < 40) setTimeout(tryTag, 250); // ~10s of grace
      else if (onDone) onDone(false);
    };

    tryTag();
  }

  // Re-stamp the turns of a reloaded (bookmarked) conversation with their
  // original ids. The history loads asynchronously, so we wait until at least as
  // many user turns have rendered as the ledger expects, then tag them in order.
  function reattachTurns(turns) {
    if (!turns || !turns.length || !siteConfig || !siteConfig.userTurnSelector) return;
    let attempts = 0;

    const tryReattach = () => {
      const els = getUserTurnEls();
      if (els.length >= turns.length) {
        for (let i = 0; i < turns.length; i++) turnLedger[i] = turns[i].id;
        reconcileTurnTags();
        ensureTurnObserver();
        return;
      }
      if (attempts++ < 60) setTimeout(tryReattach, 500); // ~30s for history to load
    };

    tryReattach();
  }

  // Broadcast the user's prompt. The background worker mints the shared turn id
  // and returns it; onTurnId is invoked with it so the caller can tag the local
  // turn with the same id the injection targets will use.
  function broadcastPrompt(prompt, source, onTurnId) {
    const now = Date.now();
    if (prompt === lastBroadcastPrompt && now - lastBroadcastTime < 1000) {
      return;
    }
    lastBroadcastPrompt = prompt;
    lastBroadcastTime = now;

    // A workspace pane (Tiled in a Tab) is not in the managed-window set, so the
    // managed-window-gated broadcast_prompt path would be blocked. Route it through
    // the tab-scoped workspace path instead, carrying `source` so the typing pane
    // isn't re-injected. Tiled Windows / top frames use the original path.
    const message = isWorkspacePane
      ? { action: 'workspace_broadcast', prompt: prompt, source: source }
      : { action: 'broadcast_prompt', prompt: prompt, source: source };

    chrome.runtime.sendMessage(
      message,
      (response) => {
        void chrome.runtime.lastError;
        if (onTurnId && response && response.turnId) onTurnId(response.turnId);
      }
    );
  }

  // --- Conversation URL reporting ------------------------------------------
  //
  // Chatbots are SPAs: after the first prompt they replace the launcher URL with
  // a conversation permalink via the History API. Chrome surfaces that through
  // tabs.onUpdated, but Safari does not fire it for history navigations — so we
  // report our own URL from inside the page, where the change is always visible.
  // The background persists it onto the active saved session.
  let lastSentUrl = null;

  function reportUrl() {
    const url = location.href;
    if (url === lastSentUrl) return;
    lastSentUrl = url;
    chrome.runtime.sendMessage({ action: 'session_url', url: url }, () => void chrome.runtime.lastError);
  }

  // Force a few re-checks shortly after a submission, when the permalink appears.
  function scheduleUrlReports() {
    [1000, 2500, 5000, 9000].forEach((t) => setTimeout(reportUrl, t));
  }

  // Read the current draft text out of an editor (textarea, input or
  // contenteditable) without assuming which kind it is.
  function readPrompt(field) {
    const value = field.value != null ? field.value : field.innerText;
    return (value || '').trim();
  }

  // Set the editor text safely. For form controls we use the native value
  // setter so React notices the change; contenteditables go through
  // setContentEditableText below.
  function setEditorText(field, text) {
    field.focus();

    const tag = field.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(field, text);
      field.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setContentEditableText(field, text);
    }
  }

  function selectAllIn(field) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(field);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  // Rich editors (ProseMirror/Lexical) keep an internal document model and can
  // revert DOM mutations they didn't make — which looks like the injected text
  // flashing in (or never appearing) and the composer staying empty. So try
  // strategies that go through the editor's own input pipeline first, verifying
  // after each, and only fall back to direct DOM mutation as a last resort.
  function setContentEditableText(field, text) {
    const matches = () => readPrompt(field) === text.trim();

    // 1) execCommand('insertText'): deprecated, but routes through beforeinput,
    // which is exactly how these editors ingest typing.
    field.focus();
    selectAllIn(field);
    try { document.execCommand('insertText', false, text); } catch (e) { /* ignore */ }
    if (matches()) {
      dbg('inserted via execCommand');
      return;
    }

    // 2) Synthetic paste: rich editors implement their own paste handling and
    // don't require a trusted event for it.
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      field.focus();
      selectAllIn(field);
      field.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (e) { /* ignore */ }
    if (matches()) {
      dbg('inserted via synthetic paste');
      return;
    }

    dbg('falling back to direct DOM insertion (editor may revert it)');

    // 3) Direct DOM mutation (never innerHTML, so markup in prompts stays
    // verbatim). Frameworks may revert this on their next render; the
    // send-button wait in submitInjectedPrompt gives them time to settle.
    field.replaceChildren();
    const p = document.createElement('p');
    p.textContent = text;
    field.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    // Fast path: a normal in-flow element with a layout box is visible.
    if (el.offsetParent !== null) return true;
    // offsetParent is null for position:fixed elements (and anything inside a
    // transformed/contained ancestor) even when fully visible — e.g. Gemini's
    // launcher composer. A sized box that isn't explicitly hidden still counts.
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // The composer editor. The site configs list selectors most-specific first
  // (e.g. '#prompt-textarea' before the broad 'div[contenteditable="true"]'),
  // so honour that order: use the first selector that has any visible match.
  // Within one selector take the last visible match — these UIs render their
  // composer at the bottom of the page, below stray editable elements.
  function findEditor(config) {
    for (const selector of config.inputSelector.split(',')) {
      const visible = Array.from(document.querySelectorAll(selector.trim())).filter(isVisible);
      if (visible.length) return visible[visible.length - 1];
    }
    return null;
  }

  // A send button that can actually be clicked right now. While a response is
  // streaming the sites disable the button or swap it for a "stop" control, in
  // which case this returns null and the caller should wait.
  function findSendButton(config) {
    return Array.from(document.querySelectorAll(config.sendSelector)).find(b =>
      isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
    ) || null;
  }

  function dispatchEnter(field) {
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      shiftKey: false,
      bubbles: true,
      cancelable: true
    }));
  }

  // Submit the composer: click the site's send button, or fall back to an
  // Enter keypress on the editor. Used when sending the user's own prompt in
  // the source window (where the button is expected to be ready immediately).
  function clickSendOrEnter(config, field) {
    const sendBtn = findSendButton(config);
    if (sendBtn) {
      sendBtn.click();
    } else {
      dispatchEnter(field);
    }
  }

  // Submit an injected prompt, waiting out streaming. The send button may be
  // unavailable for a long while (a previous response still generating), so we
  // poll for a clickable one before resorting to a synthetic Enter — which
  // sites are free to ignore (isTrusted === false), making it a true last
  // resort.
  //
  // After clicking we WATCH for proof the submit landed before ever resending,
  // because a premature resend double-posts the prompt. The first prompt is the
  // dangerous case: the site transitions from its launcher to a conversation
  // (often a real navigation), so the rendered user turn can lag well past a
  // second — long enough that a fixed-delay "is the composer still full?" check
  // mistakes an in-flight send for a swallowed click and fires it again
  // (observed on Gemini and Claude, worse with long prompts). Any one of these
  // means it sent, and once sent we must never resend:
  //   - a new user turn rendered, or
  //   - the URL changed (a conversation permalink replaced the launcher), or
  //   - the composer emptied (the site accepted and cleared the draft).
  // Only when none of those happen for a sustained window AND the composer still
  // holds the exact prompt do we treat the click as swallowed and retry once.
  function submitInjectedPrompt(config, field, prompt, turnId, beforeCount) {
    let clickAttempts = 0;
    let resent = false;
    let settled = false;
    const expected = prompt.trim();
    const startUrl = location.href;

    const finish = () => {
      if (settled) return;
      settled = true;
      // Report the outcome to the workspace status line (when we're a pane):
      // a freshly rendered user turn is the proof the prompt actually went out.
      tagNewUserTurn(turnId, beforeCount, (sent) => {
        dbg('user turn rendered:', sent);
        // Report the outcome: to the workspace bar when we're a pane, or to the
        // Tiled-Windows shared prompt bar when we're a managed top-frame window.
        chrome.runtime.sendMessage(
          {
            action: isWorkspacePane ? 'workspace_inject_result' : 'tiled_inject_result',
            model: config.source,
            ok: sent
          },
          () => void chrome.runtime.lastError
        );
      });
      scheduleUrlReports();
      setTimeout(() => { isProgrammaticInput = false; }, 500);
    };

    const sentSignal = () =>
      getUserTurnEls().length > beforeCount || location.href !== startUrl;

    const watch = () => {
      let polls = 0;
      const tick = () => {
        if (settled) return;
        if (sentSignal()) { finish(); return; }
        const editor = findEditor(config);
        if (!editor || readPrompt(editor) !== expected) {
          // Composer no longer holds our prompt: the site accepted and cleared
          // it. Don't resend; finish() confirms via the rendered turn.
          finish();
          return;
        }
        // Prompt still sitting in the composer and nothing has happened yet —
        // keep watching (~8s) before concluding the click was swallowed.
        if (polls++ < 16) { setTimeout(tick, 500); return; }
        if (!resent) {
          resent = true;
          dbg('send did not land; re-inserting and retrying once');
          setEditorText(editor, prompt);
          setTimeout(tryClick, 700);
          return;
        }
        finish();
      };
      tick();
    };

    const tryClick = () => {
      if (settled) return;
      const btn = findSendButton(config);
      if (btn) {
        dbg('clicking send button');
        btn.click();
        watch();
        return;
      }
      // ~45s of patience: long enough for a slow previous response to finish
      // streaming and the send button to come back.
      if (clickAttempts++ < 90) {
        setTimeout(tryClick, 500);
        return;
      }
      console.warn('[Multi-Prompt] no clickable send button appeared; dispatching synthetic Enter (sites may ignore it)');
      dispatchEnter(findEditor(config) || field);
      finish();
    };

    tryClick();
  }

  // Fill the editor with the prompt and submit it. Retries while the SPA is
  // still mounting its editor. The injection guard is released only once
  // submission has actually been triggered, rather than after a fixed timeout.
  function injectPrompt(config, prompt, turnId) {
    let attempts = 0;

    const tryInject = () => {
      const field = findEditor(config);
      if (!field) {
        if (attempts++ > 15) {
          console.warn('[Multi-Prompt] inject failed: no visible editor for selector', config.inputSelector);
          isProgrammaticInput = false;
          chrome.runtime.sendMessage(
            {
              action: isWorkspacePane ? 'workspace_inject_result' : 'tiled_inject_result',
              model: config.source,
              ok: false
            },
            () => void chrome.runtime.lastError
          );
          return;
        }
        setTimeout(tryInject, 1000);
        return;
      }

      // Snapshot the user-turn count before we submit so the freshly rendered
      // one can be identified and tagged with the shared turn id.
      const beforeCount = getUserTurnEls().length;
      const expected = prompt.trim();

      setEditorText(field, prompt);

      // Verify the fill actually took before submitting. Rich editors (Gemini's
      // <rich-textarea>, ProseMirror) can silently reject an injected fill —
      // especially a long prompt — leaving the composer empty and the send
      // button disabled, so we'd otherwise poll a button that never enables
      // (the "Gemini just sits on the empty launcher" symptom). Re-fill a few
      // times, then submit regardless so a mis-reading editor still gets a try.
      let fillAttempts = 0;
      const submitWhenFilled = () => {
        const f = findEditor(config) || field;
        if (readPrompt(f) !== expected && fillAttempts++ < 3) {
          dbg('composer did not accept the fill; re-inserting', fillAttempts);
          setEditorText(f, prompt);
          setTimeout(submitWhenFilled, 600);
          return;
        }
        submitInjectedPrompt(config, f, prompt, turnId, beforeCount);
      };
      setTimeout(submitWhenFilled, 800);
    };

    tryInject();
  }

  // --- Private / temporary chat mode -----------------------------------------
  //
  // Entering private mode means clicking the site's private/temporary-chat
  // toggle on the launcher page. It IS a toggle — a second click would leave
  // private mode again — so a page-lifetime guard makes repeated requests
  // (auto-privatize on launch plus the workspace bar button, or a heartbeat
  // re-registration) idempotent. Where the site exposes a detectable "private"
  // state (config.isPrivateChat), that is the ground truth; otherwise the
  // guard alone protects against double-clicking. Reset by 'new_chat', which
  // navigates back to a normal (non-private) fresh chat without a page load.
  let privateModeEntered = false;

  function isPrivateNow(config) {
    if (privateModeEntered) return true;
    try { return !!(config.isPrivateChat && config.isPrivateChat()); }
    catch (e) { return false; }
  }

  function enterPrivateChat(config, onDone) {
    if (isPrivateNow(config)) {
      privateModeEntered = true;
      onDone(true);
      return;
    }
    let attempts = 0;

    const tryClick = () => {
      if (isPrivateNow(config)) { privateModeEntered = true; onDone(true); return; }
      const btn = config.findPrivateButton ? config.findPrivateButton() : null;
      if (!btn || !isVisible(btn)) {
        // The SPA may still be mounting its top bar — ~10s of grace.
        if (attempts++ < 20) { setTimeout(tryClick, 500); return; }
        console.warn('[Multi-Prompt] no private/temporary-chat button found');
        onDone(false);
        return;
      }
      dbg('clicking private-chat button');
      btn.click();
      // Guard immediately: whatever happens next, never click the toggle twice.
      privateModeEntered = true;
      if (!config.isPrivateChat) { onDone(true); return; }
      // Verifiable sites: confirm the state actually flipped before reporting.
      setTimeout(() => onDone(!!config.isPrivateChat()), 1200);
    };

    tryClick();
  }

  // --- In-page floating button ---------------------------------------------
  //
  // When tiled into narrow side-by-side windows, the pinned toolbar action can
  // get pushed into the overflow menu and disappear. So in windows the extension
  // manages, we inject a small floating button styled like the extension icon:
  // it both signals "this chat is part of a Multi-Prompt session" and reopens
  // the popup (via the background, since content scripts can't open it directly).

  const FAB_POS_KEY = 'mp-fab-pos';

  function readFabPos() {
    try { return JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function writeFabPos(pos) {
    try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ }
  }

  // Ask the background whether this window is extension-managed, retrying a few
  // times because the managed-window set is written just after the window is
  // created — the content script can load and ask before it lands.
  function requestManagedButton(attempt) {
    attempt = attempt || 0;
    chrome.runtime.sendMessage({ action: 'query_managed' }, (response) => {
      const err = chrome.runtime.lastError;
      if (!err && response && response.managed) {
        // When the session has a shared prompt bar, that bar hosts the panel
        // button — so suppress (and clear) the in-page floating one.
        if (response.hasBar) removeManagedButton();
        else injectManagedButton();
        return;
      }
      if (attempt < 5) setTimeout(() => requestManagedButton(attempt + 1), 1000);
    });
  }

  function removeManagedButton() {
    const btn = document.getElementById('mp-fab');
    if (btn) btn.remove();
  }

  function injectManagedButton() {
    if (document.getElementById('mp-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'mp-fab';
    btn.type = 'button';
    btn.textContent = 'M';
    btn.setAttribute('aria-label', 'Open Multi-Prompt panel');
    btn.title =
      'Multi-Prompt — this chat is part of a managed split-view session.\n' +
      'Click to open the Multi-Prompt panel (broadcast a prompt, rearrange or ' +
      'export the chats, save/open sessions).\n' +
      'Drag to reposition.';
    btn.style.cssText = [
      'position:fixed', 'z-index:2147483647',
      'width:40px', 'height:40px',
      'display:flex', 'align-items:center', 'justify-content:center',
      'font:700 22px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'color:#fff', 'border:none', 'border-radius:12px',
      'background:linear-gradient(135deg,#7c3aed 0%,#d946ef 100%)',
      'box-shadow:0 4px 14px rgba(0,0,0,.35)',
      'cursor:pointer', 'opacity:.9', 'user-select:none',
      'padding:0', 'margin:0',
      'transition:transform .12s ease,opacity .12s ease'
    ].join(';') + ';';

    // Restore a saved position, otherwise default to the bottom-right corner.
    const saved = readFabPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      btn.style.left = saved.left + 'px';
      btn.style.top = saved.top + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';
    } else {
      btn.style.right = '18px';
      btn.style.bottom = '18px';
    }

    // Activate the panel. Driven from mouseup (not the click event): on Safari,
    // calling preventDefault() in mousedown — which we need to stop text
    // selection while dragging — suppresses the follow-up click, so the click
    // handler never ran and the button appeared dead.
    function activatePanel() {
      btn.textContent = '…';
      chrome.runtime.sendMessage({ action: 'open_popup' }, () => {
        void chrome.runtime.lastError;
        btn.textContent = 'M';
      });
    }

    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      const r = btn.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      e.preventDefault(); // suppress text selection only once a drag is underway
      const nx = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, ox + dx));
      const ny = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, oy + dy));
      btn.style.left = nx + 'px'; btn.style.top = ny + 'px';
      btn.style.right = 'auto'; btn.style.bottom = 'auto';
    }, true);

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        writeFabPos({ left: parseInt(btn.style.left, 10), top: parseInt(btn.style.top, 10) });
      } else {
        // A press without a drag is a click — open the panel.
        activatePanel();
      }
    }, true);

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1.08)'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '.9'; btn.style.transform = 'scale(1)'; });

    (document.body || document.documentElement).appendChild(btn);
  }

  function init(config) {
    siteConfig = config;

    // Frame roles: the tab's top frame (window-tiling mode), a workspace pane
    // root (direct child of the workspace page), or a nested helper iframe the
    // sites embed within themselves on the same origin (login/cookie-rotation/
    // analytics frames). Nested frames have no composer — and if they ran this
    // script their hello would overwrite the pane's registration and hijack its
    // broadcasts (observed with ChatGPT/Gemini) — so they opt out entirely.
    const isTopFrame = window.self === window.top;
    const isPaneRoot = !isTopFrame && window.parent === window.top;
    if (!isTopFrame && !isPaneRoot) return;
    isWorkspacePane = isPaneRoot;

    // Whether a direct keystroke in this box also broadcasts to the other panes.
    // Read once, then track live so flipping the popup switch takes effect without
    // reloading the chats.
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ broadcastOnTypePref: false }, (items) => {
        broadcastOnType = items ? !!items.broadcastOnTypePref : false;
      });
    }
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.broadcastOnTypePref) {
          broadcastOnType = !!changes.broadcastOnTypePref.newValue;
        }
      });
    }

    requestManagedButton();

    // A pane root announces which model it hosts so the shared prompt box can
    // target it by frameId. Sent as a heartbeat (not just once) so a pane that
    // reloads, or a registry lost to background restarts, re-registers within
    // seconds. If the background knows this pane's session already has a
    // conversation (we reloaded back to the blank launcher), it answers with
    // the URL to return to.
    const sendWorkspaceHello = () => {
      chrome.runtime.sendMessage(
        { action: 'workspace_hello', model: config.source, private: isPrivateNow(config) },
        (response) => {
          void chrome.runtime.lastError;
          // Only honour a "restore to your conversation" steer when THIS page is
          // an empty launcher — i.e. a spontaneous reload dumped us back to a
          // blank chat (zero rendered user turns). If any user turn is already
          // present, a live conversation is loaded here, possibly mid-stream, and
          // navigating would reset it (the cause of "Gemini answers, then resets"
          // — Gemini streams the first answer while its URL still reads as the
          // launcher, so the background keeps offering to restore the permalink).
          if (response && response.navigate && getUserTurnEls().length === 0) {
            location.href = response.navigate;
          }
        }
      );
    };
    if (isPaneRoot) sendWorkspaceHello();

    // Heartbeat: report our URL (so the saved session learns the conversation
    // permalink — covers SPA navigations tabs.onUpdated misses in Safari) and,
    // for a pane root, keep the workspace registration fresh.
    reportUrl();
    setInterval(() => {
      reportUrl();
      if (isPaneRoot) sendWorkspaceHello();
    }, 2000);

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'inject_prompt') {
        isProgrammaticInput = true;
        injectPrompt(config, request.prompt, request.turnId);
        sendResponse({ success: true });
      } else if (request.action === 'new_chat') {
        // A new chat is a brand new conversation; forget the turns we tagged in
        // the old one so the repair observer doesn't chase detached nodes. It
        // also leaves private mode (the sites return to a normal fresh chat),
        // so the private guard resets with it.
        turnLedger.length = 0;
        privateModeEntered = false;
        config.newChat();
        sendResponse({ success: true });
      } else if (request.action === 'enter_private_chat') {
        enterPrivateChat(config, (ok) => sendResponse({ success: ok }));
        return true; // responds asynchronously (polls for the site's button)
      } else if (request.action === 'reattach_turns') {
        reattachTurns(request.turns);
        sendResponse({ success: true });
      } else if (request.action === 'show_managed_button') {
        // Background telling us this window is part of a managed session — show
        // the floating button without waiting on the query_managed poll (which
        // can race window creation for fast-loading launcher pages).
        injectManagedButton();
        sendResponse({ success: true });
      } else if (request.action === 'hide_managed_button') {
        // The session has a shared prompt bar that hosts the panel button, so
        // remove the in-page floating one (covers a bar added mid-session).
        removeManagedButton();
        sendResponse({ success: true });
      } else if (request.action === 'extract_chat_history') {
        const history = typeof config.extractHistory === 'function' ? config.extractHistory() : [];
        sendResponse({ success: true, history: history });
      }
    });

    // Intercept the user's Enter submission. We take over submission entirely
    // (preventing the site's own Enter handling) so this window and the
    // mirrored windows all submit through the same code path — some sites
    // otherwise broadcast correctly but fail to submit locally. Shift+Enter
    // (newline) and IME composition are left untouched.
    document.addEventListener('keydown', (e) => {
      if (isProgrammaticInput) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

      const field = e.target.closest(config.inputSelector);
      if (!field) return;

      const prompt = readPrompt(field);
      if (!prompt) return;

      e.preventDefault();
      e.stopPropagation();

      // Capture the user-turn count before we submit so our own rendered turn
      // can be tagged with the same id the broadcast targets receive. Only broadcast
      // to the other panes when the user opted in; otherwise this submits here only.
      if (broadcastOnType) {
        const beforeCount = getUserTurnEls().length;
        broadcastPrompt(prompt, config.source, (turnId) => tagNewUserTurn(turnId, beforeCount));
      }

      isProgrammaticInput = true;
      clickSendOrEnter(config, field);
      scheduleUrlReports();
      setTimeout(() => { isProgrammaticInput = false; }, 500);
    }, true);

    const handleSendActivation = (e) => {
      if (isProgrammaticInput) return;
      if (!e.target.closest(config.sendSelector)) return;

      const field = findEditor(config);
      if (!field) return;

      const prompt = readPrompt(field);
      if (!prompt) return;

      if (broadcastOnType) {
        const beforeCount = getUserTurnEls().length;
        broadcastPrompt(prompt, config.source, (turnId) => tagNewUserTurn(turnId, beforeCount));
      }
      scheduleUrlReports();
    };

    document.addEventListener('mousedown', handleSendActivation, true);
    document.addEventListener('click', handleSendActivation, true);
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName;

    // Skip hidden elements, utility elements, copy buttons, buttons, svgs, etc.
    if (tagName === 'BUTTON' || tagName === 'SVG' || node.classList.contains('sr-only') || node.getAttribute('aria-hidden') === 'true') {
      return '';
    }

    const children = Array.from(node.childNodes).map(nodeToMarkdown).join('');

    switch (tagName) {
      case 'P':
        return '\n\n' + children.trim() + '\n\n';
      case 'STRONG':
      case 'B':
        return '**' + children + '**';
      case 'EM':
      case 'I':
        return '*' + children + '*';
      case 'CODE':
        if (node.parentNode && node.parentNode.tagName === 'PRE') {
          return children;
        }
        return '`' + children + '`';
      case 'PRE':
        const codeText = node.textContent || '';
        const codeClass = node.querySelector('code')?.className || '';
        const langMatch = codeClass.match(/language-(\w+)/);
        const lang = langMatch ? langMatch[1] : '';
        return '\n\n```' + lang + '\n' + codeText.replace(/^\s+|\s+$/g, '') + '\n```\n\n';
      case 'H1': return '\n\n# ' + children.trim() + '\n\n';
      case 'H2': return '\n\n## ' + children.trim() + '\n\n';
      case 'H3': return '\n\n### ' + children.trim() + '\n\n';
      case 'H4': return '\n\n#### ' + children.trim() + '\n\n';
      case 'H5': return '\n\n##### ' + children.trim() + '\n\n';
      case 'H6': return '\n\n###### ' + children.trim() + '\n\n';
      case 'UL':
      case 'OL':
        return '\n' + children + '\n';
      case 'LI':
        return '* ' + children.trim() + '\n';
      case 'BR':
        return '\n';
      case 'A':
        const href = node.getAttribute('href') || '';
        return `[${children}](${href})`;
      case 'BLOCKQUOTE':
        return '\n\n> ' + children.trim().replace(/\n/g, '\n> ') + '\n\n';
      case 'TABLE':
        return '\n\n' + formatTable(node) + '\n\n';
      default:
        return children;
    }
  }

  function formatTable(tableEl) {
    let markdown = '';
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const cellTexts = cells.map(cell => cell.textContent.trim().replace(/\|/g, '\\|'));
      markdown += '| ' + cellTexts.join(' | ') + ' |\n';
      if (rowIndex === 0) {
        markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
      }
    });
    return markdown;
  }

  function filterNestedElements(elements) {
    const arr = Array.from(elements);
    return arr.filter(el => {
      let parent = el.parentElement;
      while (parent) {
        if (arr.includes(parent)) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  globalThis.MultiPrompt = {
    init: init,
    nodeToMarkdown: (node) => nodeToMarkdown(node).replace(/\n{3,}/g, '\n\n'),
    filterNested: filterNestedElements
  };
})();
