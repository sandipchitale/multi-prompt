// Per-pane "Enter key" option for the workspace panes.
//
// The multi-prompt tool already intercepts Enter inside each pane (a capture-phase
// keydown listener on `document` in common.js): plain Enter broadcasts + submits to
// every pane, Shift+Enter inserts a newline. This script adds an optional toggle that
// SWAPS those two, so the user can make Enter insert a newline and Shift+Enter submit
// (handy for composing multi-line prompts).
//
// It cooperates with common.js rather than replacing it:
//   - It listens in the capture phase on `window`, which runs BEFORE common.js's
//     `document` listener, so it can intercept first.
//   - When the user's keystroke should SUBMIT, it dispatches a synthetic plain Enter
//     on the editor. common.js catches that and runs its normal broadcast+submit path,
//     so the prompt still goes to every pane.
//   - When the keystroke should insert a NEWLINE, it stops propagation (so common.js
//     never submits) and inserts the line break itself.
//
// Runs wherever a composer can live, for consistent behavior across every mode:
//   - top-level site frames (direct tabs and the separate-window tiling mode),
//   - "Tiled in a Tab" workspace pane roots (direct children of the workspace page).
// Only deeper nested helper iframes are skipped — they never hold a composer.
// (This mirrors common.js's own frame-role split: isTopFrame || isPaneRoot.)

(function () {
  const isTopFrame = window.self === window.top;
  const isPaneRoot = !isTopFrame && window.parent === window.top;
  if (!isTopFrame && !isPaneRoot) return; // skip nested helper iframes only
  if (window.__mpEnterOptionInjected) return;
  window.__mpEnterOptionInjected = true;

  // Default false = current behavior preserved (Enter submits to all panes).
  // true = Enter inserts a newline, Shift+Enter submits.
  let swapEnter = false;
  let switchUI = null;
  // Popup-controlled gate for the whole feature. Default true: on unless the
  // popup switch turns it off.
  let uiEnabled = true;

  const SITES = {
    GEMINI:  { host: 'gemini.google.com', inject: injectGemini },
    CHATGPT: { host: 'chatgpt.com',       inject: injectChatGPT },
    CLAUDE:  { host: 'claude.ai',         inject: injectClaude }
  };

  const currentSite = Object.values(SITES).find(s => location.hostname.endsWith(s.host));
  if (!currentSite) return;

  const storageArea = (typeof chrome !== 'undefined' && chrome.storage)
    ? (chrome.storage.sync || chrome.storage.local) : null;

  const STORAGE_KEY = 'paneSwapEnter';
  // Popup switch that controls whether this whole Enter-key option is active —
  // both the injected switch and its key handling. The popup writes it to
  // chrome.storage.local, so read it from there (not the sync-preferred area).
  const UI_ENABLED_KEY = 'enterOptionEnabled';
  const localArea = (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage.local : null;

  if (storageArea) {
    storageArea.get({ [STORAGE_KEY]: false }, (items) => {
      swapEnter = items ? !!items[STORAGE_KEY] : false;
      updateSwitchState();
    });
  }

  if (localArea) {
    localArea.get({ [UI_ENABLED_KEY]: true }, (items) => {
      uiEnabled = items ? items[UI_ENABLED_KEY] !== false : true;
      applyUIEnabled();
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STORAGE_KEY]) {
        swapEnter = !!changes[STORAGE_KEY].newValue;
        updateSwitchState();
      }
      if (changes[UI_ENABLED_KEY]) {
        uiEnabled = changes[UI_ENABLED_KEY].newValue !== false;
        applyUIEnabled();
      }
    });
  }

  // Add the switch when enabled, tear it down when disabled. The MutationObserver
  // and interval below both go through inject(), which no-ops while disabled.
  function applyUIEnabled() {
    if (uiEnabled) inject();
    else removeUI();
  }

  function removeUI() {
    const existing = document.getElementById('mp-enter-option-switch');
    if (existing) existing.remove();
    switchUI = null;
  }

  function persist(value) {
    if (storageArea) storageArea.set({ [STORAGE_KEY]: value });
  }

  function updateSwitchState() {
    if (!switchUI) return;
    const input = switchUI.querySelector('input');
    if (input) input.checked = swapEnter;
    const label = switchUI.querySelector('label');
    if (label) {
      label.title = swapEnter
        ? 'Enter adds a new line; Shift+Enter sends to every pane (Ctrl+Enter to toggle)'
        : 'Enter sends to every pane; Shift+Enter adds a new line (Ctrl+Enter to toggle)';
    }
  }

  // --- UI ---
  function createSwitchUI() {
    const container = document.createElement('div');
    container.id = 'mp-enter-option-switch';
    container.style.cssText = `
      display: flex; align-items: center; gap: 6px; padding: 0 8px;
      font-family: 'Google Sans', Roboto, sans-serif; font-size: 13px;
      color: inherit; user-select: none; opacity: 0.7; transition: opacity 0.2s;
      margin-right: 8px; flex-shrink: 0; white-space: nowrap; align-self: center;`;
    container.onmouseover = () => container.style.opacity = '1';
    container.onmouseout = () => container.style.opacity = '0.7';

    const labelText = document.createElement('span');
    labelText.textContent = 'Enter: ';
    labelText.style.marginRight = '2px';
    container.appendChild(labelText);

    container.appendChild(makeIcon('M2.01 21L23 12 2.01 3 2 10l15 2-15 2z', 'Enter sends the prompt'));

    const label = document.createElement('label');
    label.style.cssText = `position: relative; display: inline-block; width: 32px; height: 18px; margin: 0 4px; cursor: pointer;`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = swapEnter;
    input.style.cssText = `opacity: 0; width: 0; height: 0; margin: 0;`;

    const slider = document.createElement('span');
    slider.className = 'slider';
    slider.style.cssText = `position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 34px;`;

    const knob = document.createElement('span');
    knob.className = 'knob';
    knob.style.cssText = `position: absolute; height: 14px; width: 14px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%;`;

    slider.appendChild(knob);
    label.appendChild(input);
    label.appendChild(slider);
    container.appendChild(label);

    container.appendChild(makeIcon('M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7h-2z', 'Enter adds a new line'));

    input.addEventListener('change', (e) => {
      swapEnter = e.target.checked;
      updateSwitchState();
      persist(swapEnter);
    });

    if (!document.getElementById('mp-enter-option-styles')) {
      const style = document.createElement('style');
      style.id = 'mp-enter-option-styles';
      style.textContent = `
        #mp-enter-option-switch input:checked + .slider { background-color: #4caf50; }
        #mp-enter-option-switch input:focus + .slider { box-shadow: 0 0 1px #4caf50; }
        #mp-enter-option-switch input:checked + .slider .knob { transform: translateX(14px); }
        @media (prefers-color-scheme: dark) { #mp-enter-option-switch .slider { background-color: #555; } }`;
      document.head.appendChild(style);
    }

    switchUI = container;
    updateSwitchState();
    return container;
  }

  function makeIcon(pathData, title) {
    const span = document.createElement('span');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
    span.appendChild(svg);
    span.style.display = 'flex';
    span.title = title;
    return span;
  }

  // --- Injection points (mirror the standalone extension's proven anchors) ---
  function injectGemini(ui) {
    let container = document.querySelector('.trailing-actions-wrapper');
    if (!container) {
      const switchBtn = document.querySelector('button.input-area-switch');
      if (switchBtn) container = switchBtn.closest('.trailing-actions-wrapper');
    }
    if (!container) {
      const micWrapper = document.querySelector('.input-buttons-wrapper-bottom');
      if (micWrapper && micWrapper.parentNode && micWrapper.parentNode.children.length > 0) {
        container = micWrapper.parentNode;
      }
    }
    if (container && container.firstElementChild !== ui) {
      container.insertBefore(ui, container.firstElementChild);
    }
  }

  function injectChatGPT(ui) {
    const textarea = document.getElementById('prompt-textarea');
    if (!textarea) return;

    let container = null;
    let current = textarea;
    for (let i = 0; i < 5; i++) {
      if (!current.parentElement) break;
      const parent = current.parentElement;
      const lastChild = parent.lastElementChild;
      if (lastChild && !lastChild.contains(textarea) && lastChild !== textarea) {
        if (lastChild.tagName === 'BUTTON' || lastChild.querySelector('button') || lastChild.querySelector('svg')) {
          container = parent;
          break;
        }
      }
      current = parent;
    }
    if (!container) container = textarea.parentElement;
    if (!container) return;

    const selectors = ['[data-testid="composer-footer"]', '.flex.items-end.gap-2'];
    let footer = null;
    for (const sel of selectors) {
      try { footer = container.querySelector(sel); if (footer) break; } catch (e) { /* ignore */ }
    }

    if (footer && !footer.contains(ui)) {
      ui.style.margin = '0 8px';
      footer.appendChild(ui);
      ui.style.marginLeft = 'auto';
    } else if (!footer) {
      const trailing = container.querySelector('[grid-area="trailing"]') ||
                       container.querySelector('[class~="[grid-area:trailing]"]');
      const group = (trailing && (trailing.querySelector('.flex') || trailing)) || null;
      if (group && !group.contains(ui)) {
        ui.style.margin = '0 6px';
        if (group.firstElementChild) group.insertBefore(ui, group.firstElementChild);
        else group.appendChild(ui);
      }
    }
  }

  function injectClaude(ui) {
    const modelSelector = document.querySelector('button[data-testid="model-selector-dropdown"]');
    if (!modelSelector) return;

    let toolbar = modelSelector.parentElement;
    while (toolbar && toolbar !== document.body) {
      const style = window.getComputedStyle(toolbar);
      if ((style.display === 'flex' || style.display === 'inline-flex') && toolbar.children.length >= 2) break;
      toolbar = toolbar.parentElement;
    }
    if (!toolbar || toolbar === document.body || toolbar.contains(ui)) return;

    let modelContainer = modelSelector;
    while (modelContainer.parentElement !== toolbar) {
      modelContainer = modelContainer.parentElement;
      if (!modelContainer || modelContainer === document.body) return;
    }

    ui.style.margin = '0 8px';
    const insertionPoint = modelContainer.nextElementSibling;
    if (insertionPoint) toolbar.insertBefore(ui, insertionPoint);
    else toolbar.appendChild(ui);
  }

  function inject() {
    if (!uiEnabled) return;
    let ui = document.getElementById('mp-enter-option-switch');
    if (!ui) ui = createSwitchUI();
    currentSite.inject(ui);
  }

  let injectTimeout;
  const observer = new MutationObserver(() => {
    if (injectTimeout) return;
    injectTimeout = requestAnimationFrame(() => { inject(); injectTimeout = null; });
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  inject();
  setInterval(inject, 5000);

  // --- Key handling (window capture, runs before common.js's document capture) ---
  const IS_SAFARI = /Safari\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);

  function insertNewlineDirectly(target) {
    target.focus();
    if (target.isContentEditable) {
      return document.execCommand('insertLineBreak') || document.execCommand('insertText', false, '\n');
    }
    if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text')) {
      return document.execCommand('insertText', false, '\n');
    }
    return false;
  }

  function makeEnterEvent(type, shiftKey, src) {
    const event = new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
      shiftKey: shiftKey, ctrlKey: src.ctrlKey, altKey: src.altKey, metaKey: src.metaKey,
      view: window
    });
    try {
      Object.defineProperty(event, 'keyCode', { value: 13, configurable: true, enumerable: true });
      Object.defineProperty(event, 'which', { value: 13, configurable: true, enumerable: true });
    } catch (err) { /* non-fatal */ }
    return event;
  }

  function isEditor(target) {
    return target.isContentEditable ||
           target.tagName === 'TEXTAREA' ||
           (target.tagName === 'INPUT' && target.type === 'text');
  }

  function handleKey(e) {
    if (e.key !== 'Enter') return; // fast path
    if (!uiEnabled) return;        // popup switch off — feature fully disabled

    // Ctrl+Enter toggles the option (all platforms).
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') {
        swapEnter = !swapEnter;
        updateSwitchState();
        persist(swapEnter);
      }
      return;
    }

    if (!swapEnter) return;       // default behavior — let common.js handle it
    if (!e.isTrusted) return;     // let our own synthetic events flow to common.js / editor

    const target = e.target;
    if (!isEditor(target)) return;

    if (e.shiftKey) {
      // User wants SUBMIT. Route through common.js by dispatching a plain Enter,
      // so the prompt is broadcast to every pane (not just submitted locally).
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') {
        target.dispatchEvent(makeEnterEvent('keydown', false, e));
      }
    } else {
      // User wants a NEWLINE. Block common.js's submit and insert the line break.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') {
        if (IS_SAFARI && insertNewlineDirectly(target)) return;
        if (target.isContentEditable) {
          target.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertLineBreak', bubbles: true, cancelable: true
          }));
        }
        target.dispatchEvent(makeEnterEvent('keydown', true, e));
      }
    }
  }

  window.addEventListener('keydown', handleKey, true);
  window.addEventListener('keypress', handleKey, true);
  window.addEventListener('keyup', handleKey, true);
})();
