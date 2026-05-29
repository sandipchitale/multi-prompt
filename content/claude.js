let isProgrammaticInput = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'inject_prompt') {
    isProgrammaticInput = true;
    injectIntoClaude(request.prompt);
    sendResponse({ success: true });
    setTimeout(() => {
      isProgrammaticInput = false;
    }, 2500); // Safety reset after programmatic injection
  }
});

function injectIntoClaude(prompt) {
  const findAndInject = (attempts = 0) => {
    if (attempts > 15) return;
    
    // Claude uses ProseMirror heavily
    const inputField = document.querySelector('.ProseMirror') ||
                       document.querySelector('div[contenteditable="true"]');
                       
    if (inputField) {
      inputField.focus();
      inputField.innerHTML = `<p>${prompt}</p>`;
      
      inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      inputField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      
      try { document.execCommand('insertText', false, ' '); } catch(e){}
      
      setTimeout(() => {
        // Claude usually uses a button with an aria-label "Send Message"
        const sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                        document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button:has(svg)');
                        
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
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
    // Claude's new chat button, usually a plus icon in top left or the Claude icon
    let newChatBtn = document.querySelector('a[href="/new"]') || 
                     document.querySelector('button[aria-label*="New Chat"]') ||
                     document.querySelector('button:has(svg.lucide-plus)');
                     
    if (!newChatBtn) {
        const elements = document.querySelectorAll('a, button, div[role="button"]');
        for (const el of elements) {
            if (el.textContent.trim().toLowerCase() === 'new chat' && el.offsetParent !== null) {
                newChatBtn = el;
                break;
            }
        }
    }
    
    if (newChatBtn) {
        newChatBtn.click();
    } else {
        // Fallback: Just navigate
        window.location.href = "https://claude.ai/new";
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
    const inputField = e.target.closest('.ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'claude');
      }
    }
  }
}, true);

document.addEventListener('mousedown', (e) => {
  if (isProgrammaticInput) return;
  
  const sendBtn = e.target.closest('button[aria-label*="Send"], button[data-testid="send-button"], button:has(svg)');
  if (sendBtn) {
    const inputField = document.querySelector('.ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'claude');
      }
    }
  }
}, true);

document.addEventListener('click', (e) => {
  if (isProgrammaticInput) return;
  
  const sendBtn = e.target.closest('button[aria-label*="Send"], button[data-testid="send-button"], button:has(svg)');
  if (sendBtn) {
    const inputField = document.querySelector('.ProseMirror, [contenteditable="true"]');
    if (inputField) {
      const prompt = inputField.innerText.trim();
      if (prompt) {
        broadcastPrompt(prompt, 'claude');
      }
    }
  }
}, true);
