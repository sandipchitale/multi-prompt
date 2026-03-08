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
  const sendBtn = document.getElementById('send-btn');
  const promptInput = document.getElementById('prompt-input');
  const errorMsg = document.getElementById('error-msg');

  // Load saved checkbox selections
  chrome.storage.local.get(['selectedModels'], (result) => {
    if (result.selectedModels) {
      checkboxes.forEach(cb => {
        cb.checked = result.selectedModels.includes(cb.value);
      });
    }
    updateState(); // update UI after loading
  });

  function updateState() {
    const selected = Array.from(checkboxes).filter(cb => cb.checked);
    const hasText = promptInput.value.trim().length > 0;
    const newChatBtn = document.getElementById('new-chat-btn');
    
    if (selected.length === 0) {
      errorMsg.textContent = "Please select at least 1 chatbot.";
      errorMsg.classList.remove('hidden');
      sendBtn.disabled = true;
      launchBtn.disabled = true;
      newChatBtn.disabled = true;
    } else {
      errorMsg.classList.add('hidden');
      sendBtn.disabled = !hasText;
      launchBtn.disabled = false;
      newChatBtn.disabled = false;
    }
  }

  checkboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      const selected = Array.from(checkboxes).filter(c => c.checked).map(c => c.value);
      chrome.storage.local.set({ selectedModels: selected });
      updateState();
    });
  });
  promptInput.addEventListener('input', updateState);
  
  // Shortcut: Shift + Enter to send
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) {
        sendBtn.click();
      }
    }
  });

  // LAUNCH BUTTON
  launchBtn.addEventListener('click', () => {
    let selected = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

    if (selected.length > 0) {
      const textSpan = launchBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Opening...";
      launchBtn.disabled = true;
      
      chrome.runtime.sendMessage({
        action: 'launch_tabs',
        models: selected
      }, () => {
        setTimeout(() => {
          textSpan.textContent = originalText;
          launchBtn.disabled = false;
          updateState();
        }, 800);
      });
    }
  });

  // NEW CHAT BUTTON
  const newChatBtn = document.getElementById('new-chat-btn');
  newChatBtn.addEventListener('click', () => {
    const selected = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

    if (selected.length > 0) {
      const textSpan = newChatBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Clearing...";
      newChatBtn.disabled = true;
      
      chrome.runtime.sendMessage({
        action: 'new_chat',
        models: selected
      }, () => {
        setTimeout(() => {
          textSpan.textContent = originalText;
          updateState();
        }, 800);
      });
    }
  });

  // SEND BUTTON
  sendBtn.addEventListener('click', () => {
    const selected = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
    const prompt = promptInput.value.trim();

    if (selected.length > 0 && prompt) {
      const textSpan = sendBtn.querySelector('.btn-text');
      const originalText = textSpan.textContent;
      textSpan.textContent = "Sending...";
      sendBtn.disabled = true;
      
      chrome.runtime.sendMessage({
        action: 'send_prompt',
        models: selected,
        prompt: prompt
      }, () => {
        setTimeout(() => {
          textSpan.textContent = "Sent!";
          setTimeout(() => {
            textSpan.textContent = originalText;
            updateState();
          }, 2000);
        }, 500);
      });
    }
  });

  // Initial state check
  updateState();
});
