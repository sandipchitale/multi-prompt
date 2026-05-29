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
    } else {
      errorMsg.classList.add('hidden');
      launchBtn.disabled = false;
      newChatBtn.disabled = false;
    }

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

  // Initial state check
  updateState();
});
