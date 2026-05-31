// Claude (claude.ai) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'claude',
  // Claude uses a ProseMirror contenteditable for its composer.
  inputSelector: '.ProseMirror, div[contenteditable="true"]',
  sendSelector: 'button[aria-label*="Send"], button[data-testid="send-button"]',
  // The rendered user-message bubble we stamp with the shared turn id.
  userTurnSelector: '[data-testid="user-message"], .font-user-message',
  newChat() {
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
      window.location.href = 'https://claude.ai/new';
    }
  },
  extractHistory() {
    const history = [];
    const rawElements = document.querySelectorAll(
      '[data-testid="user-message"], .font-user-message, [class*="font-user"], ' +
      '[data-testid="claude-message"], .font-claude-message, .font-claude-response, [class*="font-claude"]'
    );
    const elements = MultiPrompt.filterNested(rawElements);
    elements.forEach(el => {
      const isUser = el.getAttribute('data-testid') === 'user-message' || 
                     el.classList.contains('font-user-message') ||
                     Array.from(el.classList).some(cls => cls.includes('font-user'));
      if (isUser) {
        const text = el.innerText.trim();
        if (text) {
          const turnId = el.getAttribute('data-mp-turn') ||
                         el.closest('[data-mp-turn]')?.getAttribute('data-mp-turn') || null;
          history.push({ role: 'user', text: text, turnId: turnId });
        }
      } else {
        const text = MultiPrompt.nodeToMarkdown(el).trim();
        if (text) {
          history.push({ role: 'assistant', text: text });
        }
      }
    });
    return history;
  }
});
