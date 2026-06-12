// ChatGPT (chatgpt.com) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'chatgpt',
  inputSelector: '#prompt-textarea, div[contenteditable="true"]',
  sendSelector: 'button[data-testid="send-button"], button[aria-label*="Send"]',
  // The rendered user-message element we stamp with the shared turn id.
  userTurnSelector: '[data-message-author-role="user"]',
  // Temporary-chat toggle in the conversation header.
  findPrivateButton() {
    return document.querySelector('button[aria-label^="Turn on temporary" i]');
  },
  // ChatGPT exposes a detectable on-state: the URL gains ?temporary-chat=true
  // and the header button flips to "Turn off temporary chat".
  isPrivateChat() {
    if (new URLSearchParams(location.search).get('temporary-chat') === 'true') return true;
    return !!document.querySelector('button[aria-label^="Turn off temporary" i]');
  },
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
          const turnId = el.getAttribute('data-mp-turn') ||
                         el.closest('[data-mp-turn]')?.getAttribute('data-mp-turn') || null;
          history.push({ role: 'user', text: text, turnId: turnId });
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
