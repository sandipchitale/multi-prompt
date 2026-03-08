chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'inject_prompt') {
    injectIntoGemini(request.prompt);
    sendResponse({ success: true });
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
      try { document.execCommand('insertText', false, ' '); } catch(e){}
      
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
