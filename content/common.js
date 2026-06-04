// Shared multi-prompt content-script logic.
//
// Each site script (claude.js, chatgpt.js, gemini.js) runs in the same
// isolated world as this file and calls MultiPrompt.init(config) with
// site-specific selectors and a newChat() routine. All of the cross-site
// behaviour (safe text injection, submission, echo-loop guarding and
// broadcast interception) lives here so it is defined exactly once.

(function () {
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
  function tagNewUserTurn(turnId, beforeCount) {
    if (!turnId || !siteConfig || !siteConfig.userTurnSelector) return;
    let attempts = 0;

    const tryTag = () => {
      const els = getUserTurnEls();
      if (els.length > beforeCount) {
        turnLedger[els.length - 1] = turnId;
        reconcileTurnTags();
        ensureTurnObserver();
        return;
      }
      if (attempts++ < 40) setTimeout(tryTag, 250); // ~10s of grace
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

    chrome.runtime.sendMessage(
      { action: 'broadcast_prompt', prompt: prompt, source: source },
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
  // setter so React notices the change; for contenteditable we build a
  // paragraph from a text node (never innerHTML) so prompts containing
  // "<", "&" or other markup are inserted verbatim instead of being parsed.
  function setEditorText(field, text) {
    field.focus();

    const tag = field.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(field, text);
    } else {
      field.replaceChildren();
      const p = document.createElement('p');
      p.textContent = text;
      field.appendChild(p);

      // Place the caret at the end so the wake-up insertText below appends.
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Submit the composer: click the site's send button, or fall back to an
  // Enter keypress on the editor. Used both when mirroring a prompt into a
  // target window and when sending the user's own prompt in the source window.
  function clickSendOrEnter(config, field) {
    const sendBtn = document.querySelector(config.sendSelector);
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
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
  }

  // Fill the editor with the prompt and submit it. Retries while the SPA is
  // still mounting its editor, then submits via clickSendOrEnter. The injection
  // guard is released only once submission has actually been triggered, rather
  // than after a fixed timeout.
  function injectPrompt(config, prompt, turnId) {
    let attempts = 0;

    const tryInject = () => {
      const field = document.querySelector(config.inputSelector);
      if (!field) {
        if (attempts++ > 15) {
          isProgrammaticInput = false;
          return;
        }
        setTimeout(tryInject, 1000);
        return;
      }

      // Snapshot the user-turn count before we submit so the freshly rendered
      // one can be identified and tagged with the shared turn id.
      const beforeCount = getUserTurnEls().length;

      setEditorText(field, prompt);
      // Deprecated but still the most reliable nudge for rich editors
      // (ProseMirror/Lexical) to commit the change to their internal model.
      try { document.execCommand('insertText', false, ' '); } catch (e) { /* ignore */ }

      setTimeout(() => {
        clickSendOrEnter(config, field);
        tagNewUserTurn(turnId, beforeCount);
        scheduleUrlReports();
        setTimeout(() => { isProgrammaticInput = false; }, 500);
      }, 1000);
    };

    tryInject();
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
        injectManagedButton();
        return;
      }
      if (attempt < 5) setTimeout(() => requestManagedButton(attempt + 1), 1000);
    });
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
    requestManagedButton();

    // Report our URL now and whenever it changes, so the saved session learns
    // the real conversation permalink (covers SPA history navigations that
    // tabs.onUpdated misses in Safari).
    reportUrl();
    setInterval(reportUrl, 2000);

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'inject_prompt') {
        isProgrammaticInput = true;
        injectPrompt(config, request.prompt, request.turnId);
        sendResponse({ success: true });
      } else if (request.action === 'new_chat') {
        // A new chat is a brand new conversation; forget the turns we tagged in
        // the old one so the repair observer doesn't chase detached nodes.
        turnLedger.length = 0;
        config.newChat();
        sendResponse({ success: true });
      } else if (request.action === 'reattach_turns') {
        reattachTurns(request.turns);
        sendResponse({ success: true });
      } else if (request.action === 'show_managed_button') {
        // Background telling us this window is part of a managed session — show
        // the floating button without waiting on the query_managed poll (which
        // can race window creation for fast-loading launcher pages).
        injectManagedButton();
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
      // can be tagged with the same id the broadcast targets receive.
      const beforeCount = getUserTurnEls().length;
      broadcastPrompt(prompt, config.source, (turnId) => tagNewUserTurn(turnId, beforeCount));

      isProgrammaticInput = true;
      clickSendOrEnter(config, field);
      scheduleUrlReports();
      setTimeout(() => { isProgrammaticInput = false; }, 500);
    }, true);

    const handleSendActivation = (e) => {
      if (isProgrammaticInput) return;
      if (!e.target.closest(config.sendSelector)) return;

      const field = document.querySelector(config.inputSelector);
      if (!field) return;

      const prompt = readPrompt(field);
      if (!prompt) return;

      const beforeCount = getUserTurnEls().length;
      broadcastPrompt(prompt, config.source, (turnId) => tagNewUserTurn(turnId, beforeCount));
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
