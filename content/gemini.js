let isProgrammaticInput = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'inject_prompt') {
    isProgrammaticInput = true;
    injectIntoGemini(request.prompt);
    sendResponse({ success: true });
    setTimeout(() => {
      isProgrammaticInput = false;
    }, 2500); // Safety reset after programmatic injection
  }
});

function injectIntoGemini(prompt) {
  const findAndInject = (attempts = 0) => {
    if (attempts > 15) return;

    // Gemini 2026 UI usually uses this specific rich-textarea construct
    const richTextarea = document.querySelector('rich-textarea');
    const inputField = richTextarea ? richTextarea.querySelector('div[contenteditable="true"], .ProseMirror') : document.querySelector('.ProseMirror, [contenteditable="true"]');

    if (inputField) {
      inputField.focus();

      // Inject text
      inputField.innerHTML = `<p>${prompt}</p>`;

      // Force React/Angular/ProseMirror to notice the change.
      // ProseMirror often requires TextEvents or InputEvents specifically crafted
      inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      inputField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

      // Also try inserting text the "native" way to trigger all listeners
      try { document.execCommand('insertText', false, ' '); } catch (e) { }

      setTimeout(() => {
        // Find the send button. Gemini often uses a specific class or aria-label
        const sendBtn = document.querySelector('button[aria-label*="Send message"]') ||
          document.querySelector('.send-button') ||
          document.querySelector('button:has(.send-icon)') ||
          (richTextarea && richTextarea.parentElement ? richTextarea.parentElement.querySelector('button') : null);

        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          // Fallback to Enter key
          const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          });
          inputField.dispatchEvent(enterEvent);
        }
      }, 1000);
    } else {
      setTimeout(() => findAndInject(attempts + 1), 1000);
    }
  };

  findAndInject();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'new_chat') {
    let newChatBtn = null;

    // Look for elements with "New chat" text
    const elements = document.querySelectorAll('a, button, div[role="button"], span[role="button"]');
    for (const el of elements) {
      if (el.textContent.trim().toLowerCase() === 'new chat' && el.offsetParent !== null) {
        newChatBtn = el;
        break;
      }
    }

    if (newChatBtn) {
      newChatBtn.click();
    } else {
      // Fallback: Hard navigate to clear state
      window.location.href = "https://gemini.google.com/app";
    }

    sendResponse({ success: true });
  }
});

let lastBroadcastPrompt = '';
let lastBroadcastTime = 0;

function broadcastPrompt(prompt, source) {
  const now = Date.now();
  if (prompt === lastBroadcastPrompt && (now - lastBroadcastTime) < 500) {
    return;
  }
  lastBroadcastPrompt = prompt;
  lastBroadcastTime = now;

  chrome.runtime.sendMessage({
    action: 'broadcast_prompt',
    prompt: prompt,
    source: source
  }, () => {
    const err = chrome.runtime.lastError;
  });
}

// Intercept user-initiated submissions and broadcast to background
document.addEventListener('keydown', (e) => {
  if (isProgrammaticInput) return;
  
  if (e.key === 'Enter' && !e.shiftKey) {
    const inputField = e.target.closest('rich-textarea div[contenteditable="true"], .ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'gemini');
      }
    }
  }
}, true);

document.addEventListener('mousedown', (e) => {
  if (isProgrammaticInput) return;
  
  const sendBtn = e.target.closest('button[aria-label*="Send message"], .send-button, button:has(.send-icon), button:has(svg)');
  if (sendBtn) {
    const inputField = document.querySelector('rich-textarea div[contenteditable="true"], .ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'gemini');
      }
    }
  }
}, true);

document.addEventListener('click', (e) => {
  if (isProgrammaticInput) return;
  
  const sendBtn = e.target.closest('button[aria-label*="Send message"], .send-button, button:has(.send-icon), button:has(svg)');
  if (sendBtn) {
    const inputField = document.querySelector('rich-textarea div[contenteditable="true"], .ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'gemini');
      }
    }
  }
}, true);
