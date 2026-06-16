// Shared prompt bar for Tiled Windows mode: a thin, chrome-less app window
// docked below the tiled chatbot windows. Typing here broadcasts to every tiled
// window (the same `broadcast_prompt` path native typing uses), giving Safari —
// where Tiled in a Tab can't run — the same "type once" experience. The bar is
// itself a managed window, so the background accepts it as a broadcast source
// and tears it down with the rest of the session. Shared bottom-bar behaviour
// (theme, autosize, delivery badges, export-format pref) lives in bar-common.js.

document.addEventListener('DOMContentLoaded', () => {
  const chipsEl = document.getElementById('chips');
  const promptEl = document.getElementById('prompt');
  const promptShell = document.querySelector('.prompt-shell');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');

  MPBar.setupTheme();

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

  // --- Per-model delivery indicators ----------------------------------------
  // One chip per model: a connection dot (does a live tiled window exist?) plus
  // a result badge (… / ✓ / ✗) for the last broadcast, driven by the tracker.
  let order = [];
  const dots = {};
  const tracker = MPBar.createResultTracker({
    resultAction: 'promptbar_pane_result',
    targetNoun: 'window'
  });

  function buildChips(models) {
    order = models.slice();
    chipsEl.innerHTML = '';
    Object.keys(dots).forEach((m) => delete dots[m]);
    Object.keys(tracker.badges).forEach((m) => delete tracker.badges[m]);
    order.forEach((model) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = MPBar.MODEL_TITLES[model] || model;
      const dot = document.createElement('span');
      dot.className = 'pane-dot';
      const badge = document.createElement('span');
      badge.className = 'pane-result';
      chip.append(name, dot, badge);
      chipsEl.appendChild(chip);
      dots[model] = dot;
      tracker.badges[model] = badge;
    });
  }

  // Learn this session's model order, then poll connection + private state.
  chrome.runtime.sendMessage({ action: 'promptbar_init' }, (response) => {
    void chrome.runtime.lastError;
    buildChips((response && response.order) || []);
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
  promptEl.addEventListener('input', () => MPBar.autosize(promptEl, promptShell));

  function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusEl.textContent = '';
    tracker.start(order);

    // No `source`: handleBroadcast then injects into EVERY selected model. The
    // background returns once the broadcast is dispatched; per-window outcomes
    // arrive asynchronously via promptbar_pane_result.
    chrome.runtime.sendMessage({ action: 'broadcast_prompt', prompt: text }, (response) => {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      if (chrome.runtime.lastError || !response || response.status !== 'broadcasted') {
        tracker.reset();
        statusEl.textContent = 'Failed: ' +
          (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response');
        return;
      }
      promptEl.value = '';
      MPBar.autosize(promptEl, promptShell);
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
  MPBar.setupExportFormat(exportFormat);

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
