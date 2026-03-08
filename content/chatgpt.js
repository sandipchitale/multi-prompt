function injectIntoChatGPT(prompt) {
  const findAndInject = (attempts = 0) => {
    if (attempts > 15) return;
    
    const inputField = document.querySelector('#prompt-textarea') || 
                       document.querySelector('div[contenteditable="true"]');
                       
    if (inputField) {
      inputField.focus();
      if (inputField.tagName.toLowerCase() === 'textarea') {
         inputField.value = prompt;
      } else {
         inputField.innerHTML = `<p>${prompt}</p>`;
      }
      
      inputField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      inputField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      
      try { document.execCommand('insertText', false, ' '); } catch(e){}
      
      setTimeout(() => {
        const sendBtn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Send"]');
        
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        } else {
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                shiftKey: false,
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

function startNewChatGPTChat() {
    let newChatBtn = document.querySelector('a[data-testid="new-chat-button"]') || 
                     document.querySelector('button[aria-label="New chat"]');
                     
    if (!newChatBtn) {
        const elements = document.querySelectorAll('button, div[role="button"], span[role="button"]');
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
        // Fallback: Hard navigate to clear state
        window.location.href = "https://chatgpt.com/";
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'inject_prompt') {
    injectIntoChatGPT(request.prompt);
    sendResponse({ success: true });
  } else if (request.action === 'new_chat') {
    startNewChatGPTChat();
    sendResponse({ success: true });
  }
});
