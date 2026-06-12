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

  // Inline SVG icons for the tile titlebars — text glyphs (–, ⛶, …) render at
  // inconsistent optical sizes per platform; these stay fixed and inherit the
  // button's color via currentColor.
  const SVG_OPEN = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = {
    minus: SVG_OPEN + '<path d="M2.5 6h7"/></svg>',
    maximize: SVG_OPEN + '<rect x="2" y="2" width="8" height="8" rx="1.5"/></svg>',
    restore: SVG_OPEN + '<path d="M4.5 3.5v-1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1"/>' +
      '<rect x="1.5" y="4.5" width="6" height="6" rx="1"/></svg>',
    grip: '<svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">' +
      '<circle cx="2.5" cy="2.5" r="1"/><circle cx="5.5" cy="2.5" r="1"/>' +
      '<circle cx="2.5" cy="6" r="1"/><circle cx="5.5" cy="6" r="1"/>' +
      '<circle cx="2.5" cy="9.5" r="1"/><circle cx="5.5" cy="9.5" r="1"/></svg>',
  };

  // --- Theme: follow the popup's setting (auto / light / dark) --------------
  let themePref = 'auto';

  function applyTheme() {
    const dark = themePref === 'dark' ||
      (themePref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  function checkThemeRadio() {
    const radio = document.querySelector('input[name="theme"][value="' + themePref + '"]');
    if (radio) radio.checked = true;
  }

  chrome.storage.local.get(['themePref'], (result) => {
    themePref = result.themePref || 'auto';
    applyTheme();
    checkThemeRadio();
  });

  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      themePref = e.target.value;
      applyTheme();
      chrome.storage.local.set({ themePref: themePref });
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // Also fires for changes made from the popup (or another workspace tab),
  // keeping this tab's toggle in sync.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.themePref) {
      themePref = changes.themePref.newValue || 'auto';
      applyTheme();
      checkThemeRadio();
    }
  });

  // --- Per-pane broadcast results -------------------------------------------
  // 'pending' while a pane is still injecting; true/false once it reports
  // whether the prompt's user turn actually rendered. Shown as a small badge
  // in each pane's titlebar, next to the connection dot.
  let paneResults = {};
  const paneBadges = {};

  function renderResults() {
    Object.keys(paneBadges).forEach((model) => {
      const badge = paneBadges[model];
      if (!(model in paneResults)) {
        badge.textContent = '';
        badge.className = 'pane-result';
        badge.title = '';
        return;
      }
      const state = paneResults[model];
      badge.textContent = state === 'pending' ? '…' : (state ? '✓' : '✗');
      badge.className = 'pane-result ' +
        (state === 'pending' ? 'pending' : (state ? 'ok' : 'fail'));
      badge.title = state === 'pending'
        ? 'Sending the last prompt…'
        : (state ? 'Last prompt delivered' : 'Last prompt did NOT reach this pane');
    });
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

  // Tile records ({ model, el, collapseBtn, maxBtn, collapsed, savedGrow }).
  // Tile order, collapse, and maximize state are session-local — a reload
  // returns to the default equal layout.
  const panes = [];
  let maximizedModel = null;  // model of the maximized tile, or null
  let layoutBeforeMax = null; // per-tile { model, grow, collapsed } snapshot

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
    response.order.forEach((model) => {
      const pane = document.createElement('div');
      pane.className = 'pane';
      pane.style.flex = '1 1 0'; // equal share; splitters adjust flex-grow

      const title = document.createElement('h2');
      const name = document.createElement('span');
      name.textContent = MODEL_TITLES[model] || model;
      const dot = document.createElement('span');
      dot.className = 'pane-dot';
      paneTitles[model] = dot;

      const badge = document.createElement('span');
      badge.className = 'pane-result';
      paneBadges[model] = badge;

      const spacer = document.createElement('span');
      spacer.className = 'pane-title-spacer';
      const grip = document.createElement('span');
      grip.className = 'pane-grip';
      grip.innerHTML = ICONS.grip;
      grip.title = 'Drag to reorder';
      const collapseBtn = makePaneBtn('minus', 'Collapse this tile');
      const maxBtn = makePaneBtn('maximize', 'Maximize this tile');
      title.append(grip, name, dot, badge, spacer, collapseBtn, maxBtn);

      const frame = document.createElement('iframe');
      frame.src = response.urls[model];
      frame.allow = 'clipboard-read; clipboard-write';

      pane.appendChild(title);
      pane.appendChild(frame);
      panesEl.appendChild(pane);

      const p = {
        model, el: pane, titleEl: title, collapseBtn, maxBtn,
        collapsed: false, savedGrow: 1,
      };
      panes.push(p);
      title.title = 'Drag to reorder • double-click to maximize';

      collapseBtn.addEventListener('click', () => {
        if (p.collapsed) expandPane(p); else collapsePane(p);
      });
      maxBtn.addEventListener('click', () => toggleMaximize(p));
      title.addEventListener('mousedown', (e) => startTitleDrag(e, p));
      // Double-click on an expanded titlebar toggles maximize (same as the
      // button). Skipped right after a click-expand of a sliver, so the first
      // click's expansion doesn't cascade into a surprise maximize.
      title.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        if (p.collapsed) { expandPane(p); return; }
        if (p.clickExpandedAt && Date.now() - p.clickExpandedAt < 600) return;
        toggleMaximize(p);
      });
    });
    rebuildSplitters();
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

  // Walks siblings outward from a splitter to the nearest expanded pane in
  // the given direction, skipping collapsed slivers (and other splitters).
  function nearestExpanded(el, dir) {
    let cur = el;
    while (cur) {
      if (cur.classList.contains('pane') && !paneFor(cur).collapsed) return cur;
      cur = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
    }
    return null;
  }

  function startSplitterDrag(e, splitter) {
    const left = nearestExpanded(splitter.previousElementSibling, -1);
    const right = nearestExpanded(splitter.nextElementSibling, +1);
    if (!left || !right) return;
    splitter.classList.add('active');
    startGrowDrag(e, left, right, () => splitter.classList.remove('active'));
  }

  // Shared resize-drag: shifts flex-grow between two (not necessarily
  // adjacent) expanded panes. Used by the splitters and by collapsed slivers,
  // which act as splitters for their nearest expanded neighbours.
  function startGrowDrag(e, left, right, onDone) {
    e.preventDefault();
    const expanded = domPanes().filter((el) => !paneFor(el).collapsed);
    const totalGrow = expanded.reduce((a, el) => a + (parseFloat(el.style.flexGrow) || 1), 0);
    const rowWidth = panesEl.getBoundingClientRect().width;
    if (rowWidth <= 0) return;
    const minGrow = totalGrow * 0.08; // keep every pane at least ~8% wide

    const startX = e.clientX;
    const leftStart = parseFloat(left.style.flexGrow) || 1;
    const rightStart = parseFloat(right.style.flexGrow) || 1;

    // The overlay is created lazily on first movement: if it went up on
    // mousedown, the second click of a double-click would land on it instead
    // of the titlebar, and dblclick-to-expand on slivers would never fire.
    let overlay = null;

    const onMove = (ev) => {
      if (!overlay) {
        if (Math.abs(ev.clientX - startX) < 3) return;
        overlay = document.createElement('div');
        overlay.className = 'drag-overlay';
        document.body.appendChild(overlay);
      }
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
      if (overlay) overlay.remove();
      if (onDone) onDone();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  // --- Tile titlebar controls: collapse, maximize, drag-to-reorder -----------
  function makePaneBtn(icon, tip) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pane-btn';
    b.innerHTML = ICONS[icon];
    b.title = tip;
    // Don't let a button press start a titlebar drag.
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    return b;
  }

  function domPanes() {
    return Array.from(panesEl.querySelectorAll('.pane'));
  }

  function paneFor(el) {
    return panes.find((p) => p.el === el);
  }

  // Splitters sit between every adjacent pair of tiles, collapsed or not —
  // a splitter next to a fixed-width sliver resizes the nearest expanded
  // tiles on either side instead. Re-derived from DOM order after reorders.
  function rebuildSplitters() {
    panesEl.querySelectorAll('.splitter').forEach((s) => s.remove());
    const els = domPanes();
    for (let i = 1; i < els.length; i++) {
      panesEl.insertBefore(makeSplitter(), els[i]);
    }
  }

  function setCollapsed(p, collapsed) {
    p.collapsed = collapsed;
    p.el.classList.toggle('collapsed', collapsed);
    p.el.style.flex = collapsed ? '0 0 28px' : p.savedGrow + ' 1 0';
    // The sliver needs no buttons: a click anywhere on it expands, the grip
    // reorders, and the splitters around it handle resizing.
    p.collapseBtn.style.display = collapsed ? 'none' : '';
    p.maxBtn.style.display = collapsed ? 'none' : '';
    p.titleEl.title = collapsed
      ? 'Click to expand • drag the grip to reorder'
      : 'Drag to reorder • double-click to maximize';
  }

  function collapsePane(p) {
    if (maximizedModel === p.model) restoreLayout();
    if (!p.collapsed) p.savedGrow = parseFloat(p.el.style.flexGrow) || 1;
    setCollapsed(p, true);
    rebuildSplitters();
  }

  function expandPane(p) {
    // Expanding any sliver while a tile is maximized exits maximize and
    // brings back the whole pre-maximize layout (which re-expands this tile).
    if (maximizedModel) { restoreLayout(); return; }
    setCollapsed(p, false);
    rebuildSplitters();
  }

  function toggleMaximize(p) {
    if (maximizedModel === p.model) { restoreLayout(); return; }
    if (maximizedModel) restoreLayout();
    layoutBeforeMax = panes.map((q) => ({
      model: q.model,
      grow: q.collapsed ? q.savedGrow : (parseFloat(q.el.style.flexGrow) || 1),
      collapsed: q.collapsed,
    }));
    panes.forEach((q) => {
      if (q === p) {
        if (q.collapsed) setCollapsed(q, false);
      } else {
        if (!q.collapsed) q.savedGrow = parseFloat(q.el.style.flexGrow) || 1;
        setCollapsed(q, true);
      }
    });
    maximizedModel = p.model;
    p.maxBtn.innerHTML = ICONS.restore;
    p.maxBtn.title = 'Restore the tiled layout';
    rebuildSplitters();
  }

  function restoreLayout() {
    if (!layoutBeforeMax) return;
    const saved = layoutBeforeMax;
    layoutBeforeMax = null;
    const maxed = panes.find((q) => q.model === maximizedModel);
    maximizedModel = null;
    if (maxed) {
      maxed.maxBtn.innerHTML = ICONS.maximize;
      maxed.maxBtn.title = 'Maximize this tile';
    }
    saved.forEach((s) => {
      const q = panes.find((x) => x.model === s.model);
      if (!q) return;
      q.savedGrow = s.grow;
      setCollapsed(q, s.collapsed);
    });
    rebuildSplitters();
  }

  // Dragging a titlebar reorders the tiles live (sortable-list style): once the
  // pointer crosses the midpoint of another tile, the dragged tile moves past
  // it in the DOM. Reuses the splitters' overlay trick so the iframes don't
  // swallow mouse events mid-drag. A small threshold keeps plain clicks inert.
  function startTitleDrag(e, p) {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let overlay = null;

    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        dragging = true;
        p.el.classList.add('dragging');
        overlay = document.createElement('div');
        overlay.className = 'drag-overlay reorder';
        document.body.appendChild(overlay);
      }
      const els = domPanes();
      const idx = els.indexOf(p.el);
      for (let i = 0; i < els.length; i++) {
        if (i === idx) continue;
        const r = els[i].getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (i < idx && ev.clientX < mid) {
          panesEl.insertBefore(p.el, els[i]);
          rebuildSplitters();
          break;
        }
        if (i > idx && ev.clientX > mid) {
          panesEl.insertBefore(p.el, els[i].nextSibling);
          rebuildSplitters();
          break;
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      if (overlay) overlay.remove();
      p.el.classList.remove('dragging');
      // A plain click (no drag) on a collapsed sliver expands it — the whole
      // strip is the target.
      if (!dragging && p.collapsed) {
        p.clickExpandedAt = Date.now();
        expandPane(p);
      }
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

  // The prompt grows with its content (Shift+Enter) up to ~4 lines; the shell
  // relaxes from a pill to a rounded rect once it's multi-line.
  const promptShell = document.querySelector('.prompt-shell');
  const PROMPT_MAX_HEIGHT = 100;

  function autosizePrompt() {
    promptEl.style.height = 'auto';
    const h = Math.min(promptEl.scrollHeight, PROMPT_MAX_HEIGHT);
    promptEl.style.height = h + 'px';
    promptShell.classList.toggle('multiline', h > 44);
  }

  promptEl.addEventListener('input', autosizePrompt);

  function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusEl.textContent = '';
    paneResults = {};
    panes.forEach((p) => { paneResults[p.model] = 'pending'; });
    renderResults();

    chrome.runtime.sendMessage({ action: 'workspace_broadcast', prompt: text }, (response) => {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
      if (chrome.runtime.lastError || !response || response.status !== 'success') {
        paneResults = {};
        renderResults();
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
