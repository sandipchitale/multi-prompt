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
  const checkboxes = document.querySelectorAll('.ai-checkbox');
  const launchBtn = document.getElementById('launch-btn');
  const errorMsg = document.getElementById('error-msg');
  const layoutPreviewSection = document.getElementById('layout-preview-section');
  const layoutPreviewContainer = document.getElementById('layout-preview-container');
  const exportBtn = document.getElementById('export-btn');
  const exportFormat = document.getElementById('export-format');
  const closeTilesBtn = document.getElementById('close-tiles-btn');

  // We maintain an ordered array of selected models: e.g. ['gemini', 'claude']
  let selectedModels = [];

  const MODEL_METADATA = {
    gemini: { name: 'Gemini', color: '#1a73e8' },
    claude: { name: 'Claude', color: '#d97752' },
    chatgpt: { name: 'ChatGPT', color: '#10a37f' }
  };

  // Load saved checkbox selections and order
  chrome.storage.local.get(['selectedModels'], (result) => {
    if (result.selectedModels && Array.isArray(result.selectedModels)) {
      selectedModels = result.selectedModels;
    } else {
      // Default: select all three in order
      selectedModels = ['gemini', 'claude', 'chatgpt'];
    }
    
    // Check corresponding checkboxes
    checkboxes.forEach(cb => {
      cb.checked = selectedModels.includes(cb.value);
    });
    
    updateState();
  });

  function renderLayoutPreview() {
    layoutPreviewContainer.innerHTML = '';
    
    if (selectedModels.length < 2) {
      layoutPreviewSection.classList.add('hidden');
      return;
    }
    
    layoutPreviewSection.classList.remove('hidden');
    
    selectedModels.forEach((model, index) => {
      // Add model chip
      const chip = document.createElement('div');
      chip.className = 'preview-chip';
      
      const meta = MODEL_METADATA[model];
      chip.innerHTML = `
        <span class="chip-dot" style="background-color: ${meta.color}"></span>
        <span>${meta.name}</span>
      `;
      layoutPreviewContainer.appendChild(chip);
      
      // Add swap button between items
      if (index < selectedModels.length - 1) {
        const nextModel = selectedModels[index + 1];
        
        const swapBtn = document.createElement('button');
        swapBtn.className = 'preview-swap-btn';
        swapBtn.title = `Swap positions of ${meta.name} and ${MODEL_METADATA[nextModel].name}`;
        swapBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 11h-14M13 7l4 4-4 4M7 13h14M11 17l-4-4 4-4"/>
          </svg>
        `;
        
        swapBtn.addEventListener('click', () => {
          // Perform swap in selectedModels array
          selectedModels[index] = nextModel;
          selectedModels[index + 1] = model;
          
          chrome.storage.local.set({ selectedModels }, () => {
            renderLayoutPreview();
            
            // Trigger physical window swap on screen!
            chrome.runtime.sendMessage({
              action: 'swap_tabs',
              model1: model,
              model2: nextModel
            }, () => {
              const err = chrome.runtime.lastError;
            });
          });
        });
        
        layoutPreviewContainer.appendChild(swapBtn);
      }
    });
  }

  function updateState() {
    const newChatBtn = document.getElementById('new-chat-btn');
    
    if (selectedModels.length === 0) {
      errorMsg.classList.remove('hidden');
      launchBtn.disabled = true;
      newChatBtn.disabled = true;
      if (exportBtn) exportBtn.disabled = true;
    } else {
      errorMsg.classList.add('hidden');
      launchBtn.disabled = false;
      newChatBtn.disabled = false;
      if (exportBtn) exportBtn.disabled = false;
    }

    chrome.storage.session.get(['managedWindowIds'], (result) => {
      const hasTiles = result.managedWindowIds && result.managedWindowIds.length > 0;
      if (closeTilesBtn) closeTilesBtn.disabled = !hasTiles;
    });

    renderLayoutPreview();
  }

  checkboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      const model = cb.value;
      if (cb.checked) {
        if (!selectedModels.includes(model)) {
          selectedModels.push(model);
        }
      } else {
        selectedModels = selectedModels.filter(m => m !== model);
      }
      
      chrome.storage.local.set({ selectedModels: selectedModels }, () => {
        updateState();
      });
    });
  });

  // TILE WINDOWS BUTTON
  launchBtn.addEventListener('click', () => {
    if (selectedModels.length > 0) {
      const textSpan = launchBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Tiling...";
      launchBtn.disabled = true;
      
      const screenInfo = {
        availLeft: window.screen.availLeft || 0,
        availTop: window.screen.availTop || 0,
        availWidth: window.screen.availWidth || window.innerWidth,
        availHeight: window.screen.availHeight || window.innerHeight
      };

      chrome.runtime.sendMessage({
        action: 'launch_tabs',
        models: selectedModels,
        screenInfo: screenInfo
      }, () => {
        const err = chrome.runtime.lastError;
        setTimeout(() => {
          textSpan.textContent = originalText;
          launchBtn.disabled = false;
          updateState();
        }, 1000);
      });
    }
  });

  // NEW CHAT BUTTON
  const newChatBtn = document.getElementById('new-chat-btn');
  newChatBtn.addEventListener('click', () => {
    if (selectedModels.length > 0) {
      const textSpan = newChatBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Clearing...";
      newChatBtn.disabled = true;
      
      chrome.runtime.sendMessage({
        action: 'new_chat',
        models: selectedModels
      }, () => {
        const err = chrome.runtime.lastError;
        setTimeout(() => {
          textSpan.textContent = originalText;
          updateState();
        }, 800);
      });
    }
  });

  // EXPORT CHATS BUTTON
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
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
        currentTurn = { prompt: msgText, response: '' };
      } else {
        currentTurn.prompt += '\n\n' + msgText;
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

// Align history across all chatbots
function alignHistory(history) {
  const modelTurns = {};
  Object.keys(history).forEach(model => {
    modelTurns[model] = getChatbotTurns(history[model]);
  });

  const alignedTurns = [];

  const findMatchingAlignedTurn = (prompt) => {
    return alignedTurns.find(item => promptsMatch(item.prompt, prompt));
  };

  Object.keys(modelTurns).forEach(model => {
    modelTurns[model].forEach((turn, idx) => {
      let matched = findMatchingAlignedTurn(turn.prompt);
      if (!matched) {
        matched = {
          prompt: turn.prompt,
          responses: {},
          indices: []
        };
        alignedTurns.push(matched);
      } else {
        if (turn.prompt.length > matched.prompt.length) {
          matched.prompt = turn.prompt;
        }
      }
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

  // Clean up indices and avgIndex properties
  alignedTurns.forEach(turn => {
    delete turn.indices;
    delete turn.avgIndex;
  });

  return alignedTurns;
}
