// Shared prompt bar for Tiled Windows mode: a thin, chrome-less app window
// docked below the tiled chatbot windows. Typing here broadcasts to every tiled
// window (the same `broadcast_prompt` path native typing uses), giving Safari —
// where Tiled in a Tab can't run — the same "type once" experience. The bar is
// itself a managed window, so the background accepts it as a broadcast source
// and tears it down with the rest of the session.

document.addEventListener('DOMContentLoaded', () => {
  const chipsEl = document.getElementById('chips');
  const promptEl = document.getElementById('prompt');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');

  const MODEL_TITLES = { gemini: 'Gemini', claude: 'Claude', chatgpt: 'ChatGPT' };

  // Panel button: opens the Multi-Prompt popup (model selection, tile order,
  // saved sessions). Content scripts can't open the action popup, but the
  // service worker can — and for this toolbar-less app window it falls back to
  // opening popup.html as a standalone window.
  const menuBtn = document.getElementById('pb-menu');
  menuBtn.addEventListener('click', () => {
    menuBtn.textContent = '…';
    chrome.runtime.sendMessage({ action: 'open_popup' }, () => {
      void chrome.runtime.lastError;
      menuBtn.textContent = 'M';
    });
  });

  // --- Theme: follow the popup's setting (auto / light / dark) --------------
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

  // --- Per-model delivery indicators ----------------------------------------
  // One chip per model: a connection dot (does a live tiled window exist?) plus
  // a result badge (… sending / ✓ delivered / ✗ failed) for the last broadcast.
  let order = [];
  const dots = {};
  const badges = {};
  let results = {}; // model -> 'pending' | true | false
  const fadeTimers = {};
  const FADE_AFTER_MS = 3500;
  const FADE_DURATION_MS = 600;

  function buildChips(models) {
    order = models.slice();
    chipsEl.innerHTML = '';
    order.forEach((model) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = MODEL_TITLES[model] || model;
      const dot = document.createElement('span');
      dot.className = 'pane-dot';
      const badge = document.createElement('span');
      badge.className = 'pane-result';
      chip.append(name, dot, badge);
      chipsEl.appendChild(chip);
      dots[model] = dot;
      badges[model] = badge;
    });
  }

  function renderResults() {
    order.forEach((model) => {
      const badge = badges[model];
      if (!badge) return;
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
        : (state ? 'Last prompt delivered' : 'Last prompt did NOT reach this window');
    });
  }

  function clearFadeTimers() {
    Object.keys(fadeTimers).forEach((model) => {
      clearTimeout(fadeTimers[model]);
      delete fadeTimers[model];
    });
  }

  // A confirmed ✓ lingers briefly, then fades out, leaving just the dot.
  function scheduleSuccessFade(model) {
    clearTimeout(fadeTimers[model]);
    fadeTimers[model] = setTimeout(() => {
      if (results[model] !== true) return;
      if (badges[model]) badges[model].classList.add('fade');
      fadeTimers[model] = setTimeout(() => {
        if (results[model] !== true) return;
        delete results[model];
        renderResults();
      }, FADE_DURATION_MS);
    }, FADE_AFTER_MS);
  }

  // The background forwards each tiled window's injection result here.
  chrome.runtime.onMessage.addListener((request) => {
    if (request && request.action === 'promptbar_pane_result' && request.model in results) {
      results[request.model] = !!request.ok;
      renderResults();
      if (request.ok) scheduleSuccessFade(request.model);
    }
  });

  // Learn this session's model order, then poll connection + private state.
  chrome.runtime.sendMessage({ action: 'promptbar_init' }, (response) => {
    void chrome.runtime.lastError;
    buildChips((response && response.order) || []);
    renderResults();
  });

  const privateBtn = document.getElementById('pb-private');
  const privateBtnLabel = document.getElementById('pb-private-label');
  let privateBtnBusy = false;

  setInterval(() => {
    chrome.runtime.sendMessage({ action: 'promptbar_status' }, (response) => {
      void chrome.runtime.lastError;
      if (!response || response.status !== 'success') return;
      if (response.order && response.order.length && response.order.length !== order.length) {
        buildChips(response.order);
        renderResults();
      }
      const connected = new Set(response.connected || []);
      order.forEach((model) => {
        const dot = dots[model];
        if (!dot) return;
        const ok = connected.has(model);
        dot.classList.toggle('connected', ok);
        dot.classList.toggle('disconnected', !ok);
        dot.title = ok
          ? 'Connected — prompts reach this window'
          : 'NOT connected — this chatbot window is gone or still loading';
      });
      const isPrivate = !!response.private;
      privateBtn.classList.toggle('active', isPrivate);
      privateBtn.disabled = isPrivate || privateBtnBusy;
      if (isPrivate) {
        privateBtn.title = 'All tiled windows are in private/temporary chat mode — ' +
          'this chat will NOT be saved to Saved Sessions';
      }
    });
  }, 2000);

  // --- Switch all tiled windows to private/temporary chat -------------------
  privateBtn.addEventListener('click', () => {
    privateBtnBusy = true;
    privateBtn.disabled = true;
    privateBtnLabel.textContent = 'Switching…';
    statusEl.textContent = '';

    chrome.runtime.sendMessage({ action: 'promptbar_private' }, (response) => {
      privateBtnBusy = false;
      privateBtn.disabled = false;
      privateBtnLabel.textContent = 'Private';
      if (chrome.runtime.lastError || !response || response.status !== 'success') {
        statusEl.textContent = 'Private failed: ' +
          (chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : (response && response.error) || 'no response');
        return;
      }
      const failed = (response.results || []).filter((r) => !r.ok).map((r) => r.model);
      if (failed.length) statusEl.textContent = 'Private failed for: ' + failed.join(', ');
    });
  });

  // --- Shared prompt --------------------------------------------------------
  const promptShell = document.querySelector('.prompt-shell');
  const PROMPT_BASE_HEIGHT = 40;
  const PROMPT_MAX_HEIGHT = 100;

  function autosizePrompt() {
    promptEl.style.height = 'auto';
    const h = Math.min(Math.max(promptEl.scrollHeight, PROMPT_BASE_HEIGHT), PROMPT_MAX_HEIGHT);
    promptEl.style.height = h + 'px';
    promptShell.classList.toggle('multiline', h > PROMPT_BASE_HEIGHT + 4);
  }
  promptEl.addEventListener('input', autosizePrompt);

  function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusEl.textContent = '';
    clearFadeTimers();
    results = {};
    order.forEach((model) => { results[model] = 'pending'; });
    renderResults();

    // No `source`: handleBroadcast then injects into EVERY selected model. The
    // background returns once the broadcast is dispatched; per-window outcomes
    // arrive asynchronously via promptbar_pane_result.
    chrome.runtime.sendMessage({ action: 'broadcast_prompt', prompt: text }, (response) => {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      if (chrome.runtime.lastError || !response || response.status !== 'broadcasted') {
        results = {};
        renderResults();
        statusEl.textContent = 'Failed: ' +
          (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response');
        return;
      }
      promptEl.value = '';
      autosizePrompt();
      promptEl.focus();
    });
  }

  sendBtn.addEventListener('click', send);
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // --- Export the tiled windows' chats --------------------------------------
  const exportBtn = document.getElementById('pb-export');
  const exportFormat = document.getElementById('pb-export-format');

  chrome.storage.local.get(['exportFormatPref'], (r) => {
    if (r.exportFormatPref) exportFormat.value = r.exportFormatPref;
  });
  exportFormat.addEventListener('change', () => {
    chrome.storage.local.set({ exportFormatPref: exportFormat.value });
  });

  exportBtn.addEventListener('click', () => {
    if (!order.length) return;
    exportBtn.disabled = true;
    const original = exportBtn.textContent;
    exportBtn.textContent = 'Exporting…';

    chrome.runtime.sendMessage({ action: 'export_chats', models: order }, (response) => {
      exportBtn.disabled = false;
      exportBtn.textContent = original;
      if (chrome.runtime.lastError || !response || response.status !== 'success') {
        alert('Export failed: ' +
          (chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : (response && response.error) || 'no response'));
        return;
      }
      deliverExport(response.history, exportFormat.value); // from align.js
    });
  });

  promptEl.focus();
});
