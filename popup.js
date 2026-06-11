document.addEventListener('DOMContentLoaded', () => {
  // --- Theme Logic ---
  const themeRadios = document.querySelectorAll('input[name="theme"]');
  
  function applyTheme(theme) {
    if (theme === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  // Load saved theme
  chrome.storage.local.get(['themePref'], (result) => {
    const savedTheme = result.themePref || 'auto';
    applyTheme(savedTheme);
    
    // Check the correct radio button
    const radio = document.querySelector(`input[name="theme"][value="${savedTheme}"]`);
    if (radio) radio.checked = true;
  });

  // Listen for manual theme changes
  themeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const newTheme = e.target.value;
      applyTheme(newTheme);
      chrome.storage.local.set({ themePref: newTheme });
    });
  });

  // Listen for system theme changes if set to auto
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const checkedRadio = document.querySelector('input[name="theme"]:checked');
    if (checkedRadio && checkedRadio.value === 'auto') {
      applyTheme('auto');
    }
  });

  // --- Extension Logic ---
  const chatbotsList = document.getElementById('chatbots-list');
  const errorMsg = document.getElementById('error-msg');
  const exportBtn = document.getElementById('export-btn');
  const exportFormat = document.getElementById('export-format');
  const closeTilesBtn = document.getElementById('close-tiles-btn');
  const sessionsSelect = document.getElementById('sessions-select');
  const sessionOpenBtn = document.getElementById('session-open-btn');
  const sessionOpenWorkspaceBtn = document.getElementById('session-open-workspace-btn');
  const sessionDeleteBtn = document.getElementById('session-delete-btn');
  const sessionRenameBtn = document.getElementById('session-rename-btn');
  const sessionRenameRow = document.getElementById('session-rename-row');
  const sessionRenameInput = document.getElementById('session-rename-input');
  const sessionRenameSave = document.getElementById('session-rename-save');
  const sessionRenameCancel = document.getElementById('session-rename-cancel');
  let savedSessions = [];

  // Tiled in a Tab cannot work on Safari (its declarativeNetRequest cannot
  // remove the X-Frame-Options/CSP response headers the iframes need stripped),
  // so hide its UI there entirely rather than offering buttons that only alert.
  // Inline styles, so no shared CSS changes that could touch other browsers.
  if (location.protocol === 'safari-web-extension:') {
    const workspaceButton = document.getElementById('workspace-btn');
    if (workspaceButton) {
      // The button sits alone in its own .button-row; hide the whole row so no
      // empty gap remains.
      (workspaceButton.closest('.button-row') || workspaceButton).style.display = 'none';
    }
    if (sessionOpenWorkspaceBtn) sessionOpenWorkspaceBtn.style.display = 'none';
  }

  const ALL_MODELS = ['gemini', 'claude', 'chatgpt'];

  const MODEL_METADATA = {
    gemini: { name: 'Gemini', cardClass: 'gemini-card' },
    claude: { name: 'Claude', cardClass: 'claude-card' },
    chatgpt: { name: 'ChatGPT', cardClass: 'chatgpt-card' }
  };

  // `modelOrder` is the full top-to-bottom order of all cards (= left-to-right
  // tile order). `selected` holds which of them are actually active/tiled.
  let modelOrder = ALL_MODELS.slice();
  let selected = new Set(ALL_MODELS);

  // The ordered list of selected models — this is the tile order that gets
  // persisted as `selectedModels` for the background script to consume.
  function getSelectedModels() {
    return modelOrder.filter(m => selected.has(m));
  }

  // Load saved selections, order, and export format preference
  chrome.storage.local.get(['selectedModels', 'modelOrder', 'exportFormatPref'], (result) => {
    const sel = Array.isArray(result.selectedModels) ? result.selectedModels : ALL_MODELS.slice();
    selected = new Set(sel);

    if (Array.isArray(result.modelOrder) && ALL_MODELS.every(m => result.modelOrder.includes(m))) {
      modelOrder = result.modelOrder;
    } else {
      // Derive an order from older installs: selected ones first (in their saved
      // order), then any remaining models.
      modelOrder = sel.concat(ALL_MODELS.filter(m => !sel.includes(m)));
    }

    // Set saved export format preference
    if (exportFormat && result.exportFormatPref) {
      exportFormat.value = result.exportFormatPref;
    }

    renderChatbots();
    updateState();
  });

  // Persist the current order + selection, re-render, and — when windows are
  // already tiled — physically rearrange them to match the new order.
  function persistAndRefresh(liveRearrange) {
    const selectedModels = getSelectedModels();
    chrome.storage.local.set({ modelOrder, selectedModels }, () => {
      renderChatbots();
      updateState();
      if (liveRearrange && selectedModels.length >= 2 && chrome.storage.session) {
        chrome.storage.session.get(['managedWindowIds'], (res) => {
          const hasTiles = res.managedWindowIds && res.managedWindowIds.length > 0;
          if (hasTiles) {
            chrome.runtime.sendMessage(
              { action: 'rearrange_tiles', models: selectedModels },
              () => void chrome.runtime.lastError
            );
          }
        });
      }
    });
  }

  function toggleModel(model) {
    if (selected.has(model)) {
      selected.delete(model);
    } else {
      selected.add(model);
    }
    // Toggling does not move live windows; tiling picks up the change on the
    // next New Chat / session open.
    persistAndRefresh(false);
  }

  // Move `src` to just before/after `tgt` in the order, then live-rearrange.
  function reorderModel(src, tgt, after) {
    if (src === tgt) return;
    const arr = modelOrder.filter(m => m !== src);
    let idx = arr.indexOf(tgt);
    if (after) idx += 1;
    arr.splice(idx, 0, src);
    modelOrder = arr;
    persistAndRefresh(true);
  }

  // Swap two adjacent cards (the swap button sitting between them), then
  // live-rearrange.
  function swapAdjacent(i) {
    if (i < 0 || i + 1 >= modelOrder.length) return;
    const tmp = modelOrder[i];
    modelOrder[i] = modelOrder[i + 1];
    modelOrder[i + 1] = tmp;
    persistAndRefresh(true);
  }

  // --- Drag & drop ----------------------------------------------------------
  let dragModel = null;

  function clearDropMarkers() {
    chatbotsList.querySelectorAll('.drop-before, .drop-after').forEach(el => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function attachDragHandlers(card) {
    card.addEventListener('dragstart', (e) => {
      dragModel = card.dataset.model;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require data to be set for the drag to start.
      try { e.dataTransfer.setData('text/plain', dragModel); } catch (_) {}
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragModel = null;
      clearDropMarkers();
    });

    card.addEventListener('dragover', (e) => {
      if (!dragModel || card.dataset.model === dragModel) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Cards sit side-by-side, so drop position is decided on the X axis.
      const rect = card.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      clearDropMarkers();
      card.classList.add(after ? 'drop-after' : 'drop-before');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drop-before', 'drop-after');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const tgt = card.dataset.model;
      if (!dragModel || tgt === dragModel) return;
      const rect = card.getBoundingClientRect();
      const after = (e.clientX - rect.left) > rect.width / 2;
      reorderModel(dragModel, tgt, after);
    });
  }

  function renderChatbots() {
    chatbotsList.innerHTML = '';

    modelOrder.forEach((model, index) => {
      const meta = MODEL_METADATA[model];
      const isSelected = selected.has(model);

      const card = document.createElement('div');
      card.className = `model-card ${meta.cardClass} ${isSelected ? 'selected' : 'deselected'}`;
      card.draggable = true;
      card.dataset.model = model;
      card.innerHTML = `
        <div class="card-content">
          <span class="drag-handle" title="Drag to reorder">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="16" viewBox="0 0 12 16" fill="currentColor">
              <circle cx="3" cy="3" r="1.5"></circle><circle cx="9" cy="3" r="1.5"></circle>
              <circle cx="3" cy="8" r="1.5"></circle><circle cx="9" cy="8" r="1.5"></circle>
              <circle cx="3" cy="13" r="1.5"></circle><circle cx="9" cy="13" r="1.5"></circle>
            </svg>
          </span>
          <span class="model-name">${meta.name}</span>
          <div class="toggle-indicator"></div>
        </div>
      `;

      // Click toggles selection (a real drag does not fire a click).
      card.addEventListener('click', () => toggleModel(model));

      attachDragHandlers(card);
      chatbotsList.appendChild(card);

      // Swap button between this card and the next one — an alternative to
      // dragging for changing the left-to-right order.
      if (index < modelOrder.length - 1) {
        const nextMeta = MODEL_METADATA[modelOrder[index + 1]];
        const swapBtn = document.createElement('button');
        swapBtn.className = 'swap-btn';
        swapBtn.title = `Swap ${meta.name} and ${nextMeta.name}`;
        swapBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 11h-14M13 7l4 4-4 4M7 13h14M11 17l-4-4 4-4"/>
          </svg>
        `;
        swapBtn.addEventListener('click', () => swapAdjacent(index));
        chatbotsList.appendChild(swapBtn);
      }
    });
  }

  function updateState() {
    const newChatBtn = document.getElementById('new-chat-btn');
    const hasSelection = getSelectedModels().length > 0;

    if (!hasSelection) {
      errorMsg.classList.remove('hidden');
      newChatBtn.disabled = true;
      if (exportBtn) exportBtn.disabled = true;
    } else {
      errorMsg.classList.add('hidden');
      newChatBtn.disabled = false;
      if (exportBtn) exportBtn.disabled = false;
    }

    if (chrome.storage.session) {
      chrome.storage.session.get(['managedWindowIds'], (result) => {
        const hasTiles = result.managedWindowIds && result.managedWindowIds.length > 0;
        if (closeTilesBtn) closeTilesBtn.disabled = !hasTiles;
      });
    } else if (closeTilesBtn) {
      // No storage.session (e.g. older Safari): can't know tile state — leave the
      // Close Tiles button enabled so it remains usable.
      closeTilesBtn.disabled = false;
    }
  }

  // --- Saved Sessions -----------------------------------------------------

  function currentScreenInfo() {
    return {
      availLeft: window.screen.availLeft || 0,
      availTop: window.screen.availTop || 0,
      availWidth: window.screen.availWidth || window.innerWidth,
      availHeight: window.screen.availHeight || window.innerHeight
    };
  }

  function loadSessions() {
    if (!sessionsSelect) return;
    chrome.runtime.sendMessage({ action: 'list_sessions' }, (response) => {
      if (chrome.runtime.lastError || !response || response.status !== 'success') {
        return;
      }
      savedSessions = response.sessions || [];
      populateSessionsSelect();
    });
  }

  function populateSessionsSelect() {
    const prevValue = sessionsSelect.value;
    sessionsSelect.innerHTML = '';

    if (savedSessions.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No saved sessions';
      sessionsSelect.appendChild(opt);
      sessionsSelect.disabled = true;
    } else {
      sessionsSelect.disabled = false;
      savedSessions.forEach(session => {
        const opt = document.createElement('option');
        opt.value = session.folderId;
        opt.textContent = sessionDisplayLabel(session);
        // Always carry the original timestamp + model order as a tooltip so it's
        // recoverable even once a custom display name hides it.
        opt.title = sessionOriginalLabel(session);
        sessionsSelect.appendChild(opt);
      });
      // Keep the same session selected across a repopulate (e.g. after a rename)
      // rather than snapping back to the newest entry.
      if (prevValue && savedSessions.some(s => s.folderId === prevValue)) {
        sessionsSelect.value = prevValue;
      }
    }
    updateSessionButtons();
  }

  // The editable part of a session's name: the user's custom title if set,
  // otherwise the original timestamp-based title (kept for internal ordering).
  function sessionBaseLabel(session) {
    return session.customTitle || session.title.replace(/^Session - /, '');
  }

  // The original auto-generated label: timestamp title + model order. Used for
  // the tooltip so it stays visible even when a custom name is shown instead.
  function sessionOriginalLabel(session) {
    const base = session.title.replace(/^Session - /, '');
    const models = session.models
      .map(m => (MODEL_METADATA[m] ? MODEL_METADATA[m].name : m))
      .join(' / ');
    return models ? `${base} — ${models}` : base;
  }

  // What the dropdown shows. A user-set custom name is shown on its own; the
  // default (timestamp) entry appends the list of models for context.
  function sessionDisplayLabel(session) {
    if (session.customTitle) return session.customTitle;
    return sessionOriginalLabel(session);
  }

  function updateSessionButtons() {
    const hasSelection = !!(sessionsSelect && sessionsSelect.value);
    if (sessionOpenBtn) sessionOpenBtn.disabled = !hasSelection;
    if (sessionOpenWorkspaceBtn) sessionOpenWorkspaceBtn.disabled = !hasSelection;
    if (sessionDeleteBtn) sessionDeleteBtn.disabled = !hasSelection;
    if (sessionRenameBtn) sessionRenameBtn.disabled = !hasSelection;
    updateSessionsSelectTooltip();
  }

  // Reflect the selected session's original timestamp + model order on the
  // select itself, so the info is reachable even when a custom name hides it.
  function updateSessionsSelectTooltip() {
    if (!sessionsSelect) return;
    const session = savedSessions.find(s => s.folderId === sessionsSelect.value);
    sessionsSelect.title = (session && session.customTitle)
      ? `Saved ${sessionOriginalLabel(session)}`
      : 'Choose a saved session';
  }

  if (sessionsSelect) {
    sessionsSelect.addEventListener('change', updateSessionButtons);
  }

  if (sessionOpenBtn) {
    sessionOpenBtn.addEventListener('click', () => {
      const folderId = sessionsSelect.value;
      if (!folderId) return;
      const textSpan = sessionOpenBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = 'Opening…';
      sessionOpenBtn.disabled = true;

      chrome.runtime.sendMessage({
        action: 'open_session',
        folderId: folderId,
        screenInfo: currentScreenInfo()
      }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== 'success') {
          alert('Could not open this session.');
          textSpan.textContent = originalText;
          sessionOpenBtn.disabled = false;
          return;
        }
        setTimeout(() => { updateState(); window.close(); }, 600);
      });
    });
  }

  // Reopen a saved session tiled inside one tab (iframes) rather than as
  // separate tiled OS windows.
  if (sessionOpenWorkspaceBtn) {
    sessionOpenWorkspaceBtn.addEventListener('click', () => {
      const folderId = sessionsSelect.value;
      if (!folderId) return;
      const textSpan = sessionOpenWorkspaceBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = 'Opening…';
      sessionOpenWorkspaceBtn.disabled = true;

      chrome.runtime.sendMessage({
        action: 'open_workspace',
        folderId: folderId
      }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== 'success') {
          alert('Could not open this session tiled in a tab: ' +
            (chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : (response && response.error) || 'no response'));
          textSpan.textContent = originalText;
          sessionOpenWorkspaceBtn.disabled = false;
          return;
        }
        setTimeout(() => { window.close(); }, 400);
      });
    });
  }

  if (sessionDeleteBtn) {
    // Inline two-click confirmation. A native confirm() dialog can't be used:
    // in Safari it dismisses the popover, so the handler never runs past it and
    // the delete is never sent. Instead the first click arms the button (turns
    // it red, showing a check) and a second click within a few seconds deletes.
    let deleteArmed = false;
    let deleteArmTimer = null;

    const disarmDelete = () => {
      deleteArmed = false;
      if (deleteArmTimer) { clearTimeout(deleteArmTimer); deleteArmTimer = null; }
      sessionDeleteBtn.classList.remove('confirming');
      sessionDeleteBtn.textContent = '✕';
      sessionDeleteBtn.title = 'Delete the selected session';
    };

    sessionDeleteBtn.addEventListener('click', () => {
      const folderId = sessionsSelect.value;
      if (!folderId) return;

      if (!deleteArmed) {
        deleteArmed = true;
        sessionDeleteBtn.classList.add('confirming');
        sessionDeleteBtn.textContent = '✓';
        sessionDeleteBtn.title = 'Click again to confirm deletion';
        deleteArmTimer = setTimeout(disarmDelete, 3000);
        return;
      }

      disarmDelete();
      chrome.runtime.sendMessage({ action: 'delete_session', folderId: folderId }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== 'success') {
          console.warn('Delete failed:', chrome.runtime.lastError || (response && response.error));
          return;
        }
        loadSessions();
      });
    });

    // Changing the selected session cancels a pending confirmation.
    if (sessionsSelect) {
      sessionsSelect.addEventListener('change', disarmDelete);
    }
  }

  // --- Rename a saved session ---------------------------------------------
  // Inline editing (no prompt()/confirm(), which dismiss the popup in Safari):
  // the pencil button reveals a text field pre-filled with the current name.
  if (sessionRenameBtn && sessionRenameRow && sessionRenameInput) {
    const showRenameRow = () => {
      const folderId = sessionsSelect.value;
      if (!folderId) return;
      const session = savedSessions.find(s => s.folderId === folderId);
      if (!session) return;
      sessionRenameInput.value = sessionBaseLabel(session);
      sessionRenameRow.classList.remove('hidden');
      sessionRenameInput.focus();
      sessionRenameInput.select();
    };

    const hideRenameRow = () => {
      sessionRenameRow.classList.add('hidden');
      sessionRenameInput.value = '';
    };

    const commitRename = () => {
      const folderId = sessionsSelect.value;
      if (!folderId) { hideRenameRow(); return; }
      const title = sessionRenameInput.value.trim();
      chrome.runtime.sendMessage(
        { action: 'rename_session', folderId: folderId, title: title },
        (response) => {
          if (chrome.runtime.lastError || !response || response.status !== 'success') {
            console.warn('Rename failed:', chrome.runtime.lastError || (response && response.error));
            return;
          }
          hideRenameRow();
          loadSessions();
        }
      );
    };

    sessionRenameBtn.addEventListener('click', () => {
      if (sessionRenameRow.classList.contains('hidden')) {
        showRenameRow();
      } else {
        hideRenameRow();
      }
    });

    if (sessionRenameSave) sessionRenameSave.addEventListener('click', commitRename);
    if (sessionRenameCancel) sessionRenameCancel.addEventListener('click', hideRenameRow);

    sessionRenameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      else if (e.key === 'Escape') { e.preventDefault(); hideRenameRow(); }
    });

    // Switching sessions cancels an in-progress rename so the field can't be
    // saved against the wrong record.
    if (sessionsSelect) {
      sessionsSelect.addEventListener('change', hideRenameRow);
    }
  }

  // NEW CHAT BUTTON — tiles the selected models if they aren't open yet, then
  // starts a fresh chat in each (and a new saved session).
  const newChatBtn = document.getElementById('new-chat-btn');
  newChatBtn.addEventListener('click', () => {
    const selectedModels = getSelectedModels();
    if (selectedModels.length > 0) {
      const textSpan = newChatBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Starting...";
      newChatBtn.disabled = true;

      chrome.runtime.sendMessage({
        action: 'new_chat',
        models: selectedModels,
        screenInfo: currentScreenInfo()
      }, () => {
        const err = chrome.runtime.lastError;
        setTimeout(() => {
          textSpan.textContent = originalText;
          updateState();
          loadSessions();
        }, 1000);
      });
    }
  });

  // OPEN WORKSPACE BUTTON (experimental iframe mode)
  const workspaceBtn = document.getElementById('workspace-btn');
  if (workspaceBtn) {
    workspaceBtn.addEventListener('click', () => {
      workspaceBtn.disabled = true;
      chrome.runtime.sendMessage({ action: 'open_workspace' }, (response) => {
        workspaceBtn.disabled = false;
        if (chrome.runtime.lastError || !response || response.status !== 'success') {
          alert('Could not open Tiled in a Tab: ' +
            (chrome.runtime.lastError
              ? chrome.runtime.lastError.message
              : (response && response.error) || 'no response'));
          return;
        }
        window.close();
      });
    });
  }

  // Save export format preference
  if (exportFormat) {
    exportFormat.addEventListener('change', (e) => {
      chrome.storage.local.set({ exportFormatPref: e.target.value });
    });
  }

  // EXPORT CHATS BUTTON
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const selectedModels = getSelectedModels();
      if (selectedModels.length > 0) {
        const textSpan = exportBtn.querySelector('.btn-text');
        const originalText = textSpan.textContent;
        textSpan.textContent = "Exporting...";
        exportBtn.disabled = true;

        chrome.runtime.sendMessage({
          action: 'export_chats',
          models: selectedModels
        }, (response) => {
          const err = chrome.runtime.lastError;
          
          if (err || !response || response.status === 'error') {
            console.error("Export failed:", err || response?.error);
            alert("Export failed. Make sure your tiled chatbot windows are open and active.");
            textSpan.textContent = originalText;
            updateState();
            return;
          }

          // deliverExport (align.js) handles both Markdown download and PDF view.
          deliverExport(response.history, exportFormat ? exportFormat.value : 'markdown');

          setTimeout(() => {
            textSpan.textContent = originalText;
            updateState();
          }, 1000);
        });
      }
    });
  }

  // generateMarkdown / downloadFile live in align.js (shared with the workspace
  // export), loaded before this file by popup.html.

  // CLOSE TILES BUTTON
  if (closeTilesBtn) {
    closeTilesBtn.addEventListener('click', () => {
      const textSpan = closeTilesBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Closing...";
      closeTilesBtn.disabled = true;
      
      chrome.runtime.sendMessage({ action: 'close_tiles' }, (response) => {
        const err = chrome.runtime.lastError;
        setTimeout(() => {
          textSpan.textContent = originalText;
          updateState();
        }, 800);
      });
    });
  }

  // Listen for storage changes to keep UI in sync
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes.managedWindowIds) {
      updateState();
    }
  });

  // Initial state check
  updateState();
  loadSessions();
});

// getChatbotTurns / promptsMatch / alignHistory live in align.js (shared with
// export.js), loaded before this file by popup.html.
