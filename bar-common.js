// Shared helpers for the two Multi-Prompt bottom bars — the Tiled-in-a-Tab
// workspace composer (workspace.js) and the Tiled-Windows shared prompt bar
// (promptbar.js). Loaded before each page's own script; exposes a single global
// `MPBar`, mirroring how content/common.js exposes `MultiPrompt`.
(function () {
  'use strict';

  const MODEL_TITLES = { gemini: 'Gemini', claude: 'Claude', chatgpt: 'ChatGPT' };

  // Page theme (auto / light / dark): follow the popup's setting and keep the
  // toggle's radios in sync, for every source (init, this toggle, popup change,
  // OS change). Call once after the DOM is ready.
  function setupTheme() {
    let themePref = 'auto';
    function applyTheme() {
      const dark = themePref === 'dark' ||
        (themePref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      const radio = document.querySelector('input[name="theme"][value="' + themePref + '"]');
      if (radio) radio.checked = true;
    }
    chrome.storage.local.get(['themePref'], (result) => {
      themePref = result.themePref || 'auto';
      applyTheme();
    });
    document.querySelectorAll('input[name="theme"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        themePref = e.target.value;
        applyTheme();
        chrome.storage.local.set({ themePref: themePref });
      });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.themePref) {
        themePref = changes.themePref.newValue || 'auto';
        applyTheme();
      }
    });
  }

  // The prompt grows with its content (Shift+Enter) up to ~4 lines; the shell
  // relaxes from a pill to a rounded rect once multi-line. JS owns the height —
  // the CSS only sets the single-line base (#prompt height).
  const PROMPT_BASE_HEIGHT = 40;
  const PROMPT_MAX_HEIGHT = 100;
  function autosize(promptEl, shellEl) {
    promptEl.style.height = 'auto';
    const h = Math.min(Math.max(promptEl.scrollHeight, PROMPT_BASE_HEIGHT), PROMPT_MAX_HEIGHT);
    promptEl.style.height = h + 'px';
    shellEl.classList.toggle('multiline', h > PROMPT_BASE_HEIGHT + 4);
  }

  // Mirror the popup's saved export-format preference into a select, and persist
  // changes back.
  function setupExportFormat(selectEl) {
    chrome.storage.local.get(['exportFormatPref'], (r) => {
      if (r.exportFormatPref) selectEl.value = r.exportFormatPref;
    });
    selectEl.addEventListener('change', () => {
      chrome.storage.local.set({ exportFormatPref: selectEl.value });
    });
  }

  // Enter-key option for a bar's own prompt box — the bar-native twin of the
  // switch content/enter-option.js injects into each chatbot's composer. Both
  // read/write the SAME `paneSwapEnter` key (and honour the same popup gate,
  // `enterOptionEnabled`), so flipping it anywhere flips it everywhere.
  //   false (default) = Enter sends, Shift+Enter adds a new line
  //   true            = Enter adds a new line, Shift+Enter sends
  // Ctrl+Enter toggles, matching the injected switch's shortcut.
  //
  // Owns the prompt's Enter handling too, so the caller doesn't also bind one.
  //   containerEl : the .bar-enter control (holds one checkbox)
  //   promptEl    : the bar's textarea
  //   onSend      : called when the keystroke means "send"
  //   targetNoun  : what a send reaches, for the labels ("every pane")
  const SWAP_KEY = 'paneSwapEnter';
  const GATE_KEY = 'enterOptionEnabled';
  function setupEnterOption(containerEl, promptEl, onSend, targetNoun) {
    const noun = targetNoun || 'every pane';
    const checkbox = containerEl.querySelector('input[type="checkbox"]');
    // enter-option.js prefers `sync` for the swap value; match it or the two
    // controls would read different stores and silently disagree.
    const swapArea = chrome.storage.sync || chrome.storage.local;
    let swap = false;
    let gateOn = true;

    function render() {
      if (checkbox) checkbox.checked = swap;
      // Gated off = the whole feature is inactive, so hide the control rather
      // than show a switch that no longer changes anything.
      containerEl.hidden = !gateOn;
      // Keep the wording honest everywhere — both name the current send key.
      const sendKey = (gateOn && swap) ? 'Shift+Enter' : 'Enter';
      const newlineKey = (gateOn && swap) ? 'Enter' : 'Shift+Enter';
      promptEl.placeholder = 'Type a prompt — ' + sendKey + ' sends it to ' + noun +
        ' (' + newlineKey + ' for a newline)';
      containerEl.title = sendKey + ' sends to ' + noun + '; ' + newlineKey +
        ' adds a new line (Ctrl+Enter toggles)';
    }

    swapArea.get({ [SWAP_KEY]: false }, (items) => {
      swap = !!(items && items[SWAP_KEY]);
      render();
    });
    chrome.storage.local.get({ [GATE_KEY]: true }, (items) => {
      gateOn = !items || items[GATE_KEY] !== false;
      render();
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[SWAP_KEY]) { swap = !!changes[SWAP_KEY].newValue; render(); }
      if (changes[GATE_KEY]) { gateOn = changes[GATE_KEY].newValue !== false; render(); }
    });

    function setSwap(value) {
      swap = value;
      render();
      swapArea.set({ [SWAP_KEY]: value });
    }

    if (checkbox) {
      checkbox.addEventListener('change', (e) => setSwap(e.target.checked));
    }

    promptEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (gateOn && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setSwap(!swap);
        return;
      }
      // Gated off falls back to the plain behaviour (Enter sends), exactly as
      // content/enter-option.js stands down when the popup switch is off.
      const sends = (gateOn && swap) ? e.shiftKey : !e.shiftKey;
      if (!sends) return; // let the textarea insert the newline itself
      e.preventDefault();
      onSend();
    });
  }

  // Per-target delivery badges (… sending / ✓ delivered / ✗ failed). The caller
  // fills `tracker.badges[model] = badgeEl` as it builds its titlebars/chips.
  // The background forwards each target's result via `resultAction`, addressed
  // only to this page — the tracker installs that listener itself.
  //   options.resultAction : message action carrying { model, ok }
  //   options.targetNoun   : word used in the failure tooltip ("pane"/"window")
  function createResultTracker(options) {
    const resultAction = options.resultAction;
    const failNoun = options.targetNoun || 'target';
    const badges = {};
    let results = {}; // model -> 'pending' | true | false
    const fadeTimers = {};
    const FADE_AFTER_MS = 3500;   // ✓ dwell before it starts fading
    const FADE_DURATION_MS = 600; // matches the .pane-result opacity transition

    function clearFadeTimers() {
      Object.keys(fadeTimers).forEach((model) => {
        clearTimeout(fadeTimers[model]);
        delete fadeTimers[model];
      });
    }
    function render() {
      Object.keys(badges).forEach((model) => {
        const badge = badges[model];
        if (!badge) return;
        // (Re)painting restores full opacity; .fade is only added by the timer.
        badge.classList.remove('fade');
        if (!(model in results)) {
          badge.textContent = '';
          badge.className = 'pane-result';
          badge.title = '';
          return;
        }
        const state = results[model];
        badge.textContent = state === 'pending' ? '…' : (state ? '✓' : '✗');
        badge.className = 'pane-result ' +
          (state === 'pending' ? 'pending' : (state ? 'ok' : 'fail'));
        badge.title = state === 'pending'
          ? 'Sending the last prompt…'
          : (state ? 'Last prompt delivered' : 'Last prompt did NOT reach this ' + failNoun);
      });
    }
    // A confirmed ✓ lingers, fades, then clears — leaving just the dot. Guarded
    // so a newer state (a fresh send's …, or a late ✗) is never wiped by a stale
    // timer.
    function scheduleSuccessFade(model) {
      clearTimeout(fadeTimers[model]);
      fadeTimers[model] = setTimeout(() => {
        if (results[model] !== true) return;
        if (badges[model]) badges[model].classList.add('fade');
        fadeTimers[model] = setTimeout(() => {
          if (results[model] !== true) return;
          delete results[model];
          render();
        }, FADE_DURATION_MS);
      }, FADE_AFTER_MS);
    }
    function set(model, state) {
      results[model] = state;
      render();
      if (state === true) scheduleSuccessFade(model);
    }
    // Begin a fresh broadcast: clear stale fades and mark these targets pending.
    function start(models) {
      clearFadeTimers();
      results = {};
      models.forEach((m) => { results[m] = 'pending'; });
      render();
    }
    function reset() {
      clearFadeTimers();
      results = {};
      render();
    }
    chrome.runtime.onMessage.addListener((request) => {
      if (request && request.action === resultAction && request.model in results) {
        set(request.model, !!request.ok);
      }
    });
    return { badges: badges, start: start, set: set, reset: reset };
  }

  window.MPBar = {
    MODEL_TITLES: MODEL_TITLES,
    setupTheme: setupTheme,
    autosize: autosize,
    setupExportFormat: setupExportFormat,
    setupEnterOption: setupEnterOption,
    createResultTracker: createResultTracker
  };
})();
