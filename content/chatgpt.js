// ChatGPT (chatgpt.com) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'chatgpt',
  inputSelector: '#prompt-textarea, div[contenteditable="true"]',
  sendSelector: 'button[data-testid="send-button"], button[aria-label*="Send"]',
  newChat() {
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
      window.location.href = 'https://chatgpt.com/';
    }
  },
  extractHistory() {
    const history = [];
    const rawElements = document.querySelectorAll('[data-message-author-role]');
    const elements = MultiPrompt.filterNested(rawElements);
    elements.forEach(el => {
      const role = el.getAttribute('data-message-author-role');
      if (role === 'user') {
        const text = el.innerText.trim();
        if (text) {
          history.push({ role: 'user', text: text });
        }
      } else if (role === 'assistant') {
        const markdownEl = el.querySelector('.markdown');
        const text = markdownEl ? MultiPrompt.nodeToMarkdown(markdownEl).trim() : el.innerText.trim();
        if (text) {
          history.push({ role: 'assistant', text: text });
        }
      }
    });
    return history;
  }
});
