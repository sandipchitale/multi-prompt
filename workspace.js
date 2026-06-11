// Experimental iframe workspace: embeds each selected chatbot in an iframe and
// broadcasts the shared prompt box to all of them. The background installs the
// tab-scoped header-stripping rules in response to workspace_init, BEFORE this
// page creates any iframe — so framing is already permitted when they load.

document.addEventListener('DOMContentLoaded', () => {
  const panesEl = document.getElementById('panes');
  const promptEl = document.getElementById('prompt');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');

  const MODEL_TITLES = { gemini: 'Gemini', claude: 'Claude', chatgpt: 'ChatGPT' };

  // --- Theme: follow the popup's setting (auto / light / dark) --------------
  let themePref = 'auto';

  function applyTheme() {
    const dark = themePref === 'dark' ||
      (themePref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  chrome.storage.local.get(['themePref'], (result) => {
    themePref = result.themePref || 'auto';
    applyTheme();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.themePref) {
      themePref = changes.themePref.newValue || 'auto';
      applyTheme();
    }
  });

  // --- Per-pane broadcast results -------------------------------------------
  // 'pending' while a pane is still injecting; true/false once it reports
  // whether the prompt's user turn actually rendered.
  let paneResults = {};

  function renderResults() {
    const parts = Object.keys(paneResults).map((model) => {
      const state = paneResults[model];
      const mark = state === 'pending' ? '…' : (state ? '✓' : '✗');
      return (MODEL_TITLES[model] || model) + ' ' + mark;
    });
    statusEl.textContent = parts.join('   ');
  }

  // The background forwards each pane's injection result here, addressed only to
  // this tab (so multiple open workspaces don't cross wires).
  chrome.runtime.onMessage.addListener((request) => {
    if (request && request.action === 'workspace_pane_result' && request.model in paneResults) {
      paneResults[request.model] = !!request.ok;
      renderResults();
    }
  });

  function showNotice(text) {
    panesEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'notice';
    div.textContent = text;
    panesEl.appendChild(div);
  }

  // Pane title elements by model, for the connection indicators below.
  const paneTitles = {};

  // A saved session to reopen travels in the page hash (#session=<folderId>),
  // so each workspace tab is self-describing.
  let folderId = null;
  const m = location.hash.match(/session=([^&]+)/);
  if (m) { try { folderId = decodeURIComponent(m[1]); } catch (e) { folderId = m[1]; } }

  chrome.runtime.sendMessage({ action: 'workspace_init', folderId: folderId }, (response) => {
    if (chrome.runtime.lastError || !response || response.status !== 'success') {
      const reason = chrome.runtime.lastError
        ? chrome.runtime.lastError.message
        : (response && response.error) || 'no response';
      showNotice('Could not initialise Tiled in a Tab: ' + reason);
      return;
    }

    panesEl.innerHTML = '';
    response.order.forEach((model, i) => {
      if (i > 0) panesEl.appendChild(makeSplitter());

      const pane = document.createElement('div');
      pane.className = 'pane';
      pane.style.flex = '1 1 0'; // equal share; splitters adjust flex-grow

      const title = document.createElement('h2');
      title.append(MODEL_TITLES[model] || model, ' ');
      const dot = document.createElement('span');
      dot.className = 'pane-dot';
      title.appendChild(dot);
      paneTitles[model] = dot;

      const frame = document.createElement('iframe');
      frame.src = response.urls[model];
      frame.allow = 'clipboard-read; clipboard-write';

      pane.appendChild(title);
      pane.appendChild(frame);
      panesEl.appendChild(pane);
    });
    promptEl.focus();
  });

  // --- Resizable splitters ---------------------------------------------------
  // Panes flex-grow to fill the row; dragging a splitter shifts grow weight
  // between its two neighbours (so proportions survive a window resize). An
  // overlay covers the iframes during the drag so the parent keeps the mouse.
  function makeSplitter() {
    const s = document.createElement('div');
    s.className = 'splitter';
    s.addEventListener('mousedown', (e) => startSplitterDrag(e, s));
    return s;
  }

  function startSplitterDrag(e, splitter) {
    e.preventDefault();
    const left = splitter.previousElementSibling;
    const right = splitter.nextElementSibling;
    if (!left || !right) return;

    const panes = Array.from(panesEl.querySelectorAll('.pane'));
    const totalGrow = panes.reduce((a, p) => a + (parseFloat(p.style.flexGrow) || 1), 0);
    const rowWidth = panesEl.getBoundingClientRect().width;
    if (rowWidth <= 0) return;
    const minGrow = totalGrow * 0.08; // keep every pane at least ~8% wide

    const startX = e.clientX;
    const leftStart = parseFloat(left.style.flexGrow) || 1;
    const rightStart = parseFloat(right.style.flexGrow) || 1;

    splitter.classList.add('active');
    const overlay = document.createElement('div');
    overlay.className = 'drag-overlay';
    document.body.appendChild(overlay);

    const onMove = (ev) => {
      let dGrow = (ev.clientX - startX) * totalGrow / rowWidth;
      let lg = leftStart + dGrow;
      let rg = rightStart - dGrow;
      if (lg < minGrow) { rg -= (minGrow - lg); lg = minGrow; }
      if (rg < minGrow) { lg -= (minGrow - rg); rg = minGrow; }
      left.style.flexGrow = lg;
      right.style.flexGrow = rg;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      splitter.classList.remove('active');
      overlay.remove();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  // --- Per-pane connection indicators ----------------------------------------
  // Green dot = the pane's content script is registered (prompts can reach it),
  // red dot = it is not (pane still loading, content script missing, or stale).
  setInterval(() => {
    if (!Object.keys(paneTitles).length) return;
    chrome.runtime.sendMessage({ action: 'workspace_status' }, (response) => {
      void chrome.runtime.lastError;
      const connected = new Set((response && response.models) || []);
      Object.keys(paneTitles).forEach((model) => {
        const ok = connected.has(model);
        const dot = paneTitles[model];
        dot.classList.toggle('connected', ok);
        dot.classList.toggle('disconnected', !ok);
        dot.title = ok
          ? 'Connected — prompts reach this pane'
          : 'NOT connected — prompts cannot reach this pane right now';
      });
    });
  }, 2000);

  function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    statusEl.textContent = 'Sending…';

    chrome.runtime.sendMessage({ action: 'workspace_broadcast', prompt: text }, (response) => {
      sendBtn.disabled = false;
      if (chrome.runtime.lastError || !response || response.status !== 'success') {
        statusEl.textContent = 'Failed: ' +
          (chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : (response && response.error) || 'no response');
        return;
      }
      paneResults = {};
      response.models.forEach((m) => { paneResults[m] = 'pending'; });
      (response.failed || []).forEach((m) => { paneResults[m] = false; });
      renderResults();
      promptEl.value = '';
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

  // --- Export this tab's chats ----------------------------------------------
  const exportBtn = document.getElementById('ws-export');
  const exportFormat = document.getElementById('ws-export-format');

  // Mirror the popup's saved export-format preference.
  chrome.storage.local.get(['exportFormatPref'], (r) => {
    if (r.exportFormatPref) exportFormat.value = r.exportFormatPref;
  });
  exportFormat.addEventListener('change', () => {
    chrome.storage.local.set({ exportFormatPref: exportFormat.value });
  });

  exportBtn.addEventListener('click', () => {
    exportBtn.disabled = true;
    const original = exportBtn.textContent;
    exportBtn.textContent = 'Exporting…';

    chrome.runtime.sendMessage({ action: 'export_workspace' }, (response) => {
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
});
