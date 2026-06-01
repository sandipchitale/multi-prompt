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
  const sessionDeleteBtn = document.getElementById('session-delete-btn');
  let savedSessions = [];

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
      if (liveRearrange && selectedModels.length >= 2) {
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

    chrome.storage.session.get(['managedWindowIds'], (result) => {
      const hasTiles = result.managedWindowIds && result.managedWindowIds.length > 0;
      if (closeTilesBtn) closeTilesBtn.disabled = !hasTiles;
    });
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
        const label = session.title.replace(/^Session - /, '');
        const models = session.models
          .map(m => (MODEL_METADATA[m] ? MODEL_METADATA[m].name : m))
          .join(' / ');
        opt.textContent = models ? `${label} — ${models}` : label;
        sessionsSelect.appendChild(opt);
      });
    }
    updateSessionButtons();
  }

  function updateSessionButtons() {
    const hasSelection = !!(sessionsSelect && sessionsSelect.value);
    if (sessionOpenBtn) sessionOpenBtn.disabled = !hasSelection;
    if (sessionDeleteBtn) sessionDeleteBtn.disabled = !hasSelection;
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

  if (sessionDeleteBtn) {
    sessionDeleteBtn.addEventListener('click', () => {
      const folderId = sessionsSelect.value;
      if (!folderId) return;
      const session = savedSessions.find(s => s.folderId === folderId);
      const name = session ? session.title : 'this session';
      if (!confirm(`Delete saved session "${name}"? This removes its bookmark folder.`)) return;

      chrome.runtime.sendMessage({ action: 'delete_session', folderId: folderId }, (response) => {
        if (chrome.runtime.lastError || !response || response.status !== 'success') {
          alert('Could not delete this session.');
          return;
        }
        loadSessions();
      });
    });
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

          const history = response.history;
          const format = exportFormat ? exportFormat.value : 'markdown';

          if (format === 'markdown') {
            const mdContent = generateMarkdown(history);
            const dateStr = new Date().toISOString().slice(0, 10);
            downloadFile(mdContent, `multi-prompt-chats-${dateStr}.md`, 'text/markdown');
          } else if (format === 'pdf') {
            // Save to storage and open export page
            chrome.storage.local.set({ lastExportedHistory: history }, () => {
              chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
            });
          }

          setTimeout(() => {
            textSpan.textContent = originalText;
            updateState();
          }, 1000);
        });
      }
    });
  }

  function generateMarkdown(history) {
    let md = `# Multi-Prompt Conversation Export\n`;
    md += `Exported on: ${new Date().toLocaleString()}\n\n`;
    md += `---\n\n`;

    const modelNames = {
      gemini: 'Gemini',
      claude: 'Claude',
      chatgpt: 'ChatGPT'
    };

    const alignedTurns = alignHistory(history);

    alignedTurns.forEach(turn => {
      if (turn.prompt || Object.keys(turn.responses).length > 0) {
        if (turn.prompt) {
          md += `## 👤 Prompt\n${turn.prompt}\n\n`;
        }

        Object.entries(turn.responses).forEach(([model, responseText]) => {
          if (!responseText) return;
          const name = modelNames[model] || model;
          md += `### 🤖 ${name}\n${responseText}\n\n`;
        });

        md += `---\n\n`;
      }
    });

    return md;
  }

  function downloadFile(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

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

// Group a single model's history into turns: { prompt, response }
function getChatbotTurns(messages) {
  const turns = [];
  let currentTurn = null;

  messages.forEach(msg => {
    const msgText = (msg.text || '').trim();
    if (msg.role === 'user') {
      if (currentTurn && currentTurn.response) {
        turns.push(currentTurn);
        currentTurn = null;
      }
      if (!currentTurn) {
        currentTurn = { prompt: msgText, response: '', turnId: msg.turnId || null };
      } else {
        currentTurn.prompt += '\n\n' + msgText;
        if (!currentTurn.turnId && msg.turnId) currentTurn.turnId = msg.turnId;
      }
    } else if (msg.role === 'assistant') {
      if (!currentTurn) {
        currentTurn = { prompt: '', response: msgText };
      } else {
        if (!currentTurn.response) {
          currentTurn.response = msgText;
        } else {
          currentTurn.response += '\n\n' + msgText;
        }
      }
    }
  });
  if (currentTurn) {
    currentTurn.prompt = currentTurn.prompt.trim();
    currentTurn.response = currentTurn.response.trim();
    turns.push(currentTurn);
  }
  return turns;
}

// Compare prompt texts ignoring whitespace and case
function promptsMatch(p1, p2) {
  if (!p1 && !p2) return true;
  if (!p1 || !p2) return false;

  const clean = (text) => {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
  };

  const c1 = clean(p1);
  const c2 = clean(p2);

  if (c1 === c2) return true;

  if (c1.length > 20 && c2.length > 20) {
    if (c1.startsWith(c2) || c2.startsWith(c1)) return true;
  }

  return false;
}

// Align history across all chatbots.
//
// Turns broadcast by the extension carry a shared turnId stamped onto every
// model's rendered turn, so they are grouped exactly by that id. Turns without
// an id (e.g. typed before tiling, or where tagging failed) fall back to the
// fuzzy prompt-text match so nothing is silently dropped.
function alignHistory(history) {
  const modelTurns = {};
  Object.keys(history).forEach(model => {
    modelTurns[model] = getChatbotTurns(history[model]);
  });

  const alignedTurns = [];
  const byTurnId = new Map();

  Object.keys(modelTurns).forEach(model => {
    modelTurns[model].forEach((turn, idx) => {
      let matched = null;
      if (turn.turnId && byTurnId.has(turn.turnId)) {
        matched = byTurnId.get(turn.turnId);
      } else {
        // Find the earliest bucket this model hasn't filled yet whose prompt
        // matches and whose id is compatible. "Compatible" means at least one
        // side is untagged, or both ids are equal — so an untagged turn (e.g. a
        // model that lost its tag) still merges into a tagged group, while two
        // DIFFERENT ids never merge (keeping identical prompts separate).
        matched = alignedTurns.find(item =>
          !(model in item.responses) &&
          (item.turnId == null || turn.turnId == null || item.turnId === turn.turnId) &&
          promptsMatch(item.prompt, turn.prompt)
        );
      }

      if (!matched) {
        matched = { prompt: turn.prompt, responses: {}, turnId: null, indices: [] };
        alignedTurns.push(matched);
      }
      if (turn.turnId && matched.turnId == null) {
        matched.turnId = turn.turnId;
        byTurnId.set(turn.turnId, matched);
      }
      if (turn.prompt.length > matched.prompt.length) matched.prompt = turn.prompt;

      matched.responses[model] = turn.response;
      matched.indices.push(idx);
    });
  });

  // Calculate average index for sorting
  alignedTurns.forEach(turn => {
    const sum = turn.indices.reduce((a, b) => a + b, 0);
    turn.avgIndex = sum / turn.indices.length;
  });

  // Sort aligned turns chronologically by average index
  alignedTurns.sort((a, b) => a.avgIndex - b.avgIndex);

  // Clean up bookkeeping properties
  alignedTurns.forEach(turn => {
    delete turn.indices;
    delete turn.avgIndex;
    delete turn.turnId;
  });

  return alignedTurns;
}
