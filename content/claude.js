chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'inject_prompt') {
    injectIntoClaude(request.prompt);
    sendResponse({ success: true });
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
