// Claude (claude.ai) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'claude',
  // Claude uses a ProseMirror contenteditable for its composer.
  inputSelector: '.ProseMirror, div[contenteditable="true"]',
  sendSelector: 'button[aria-label*="Send"], button[data-testid="send-button"]',
  // The rendered user-message bubble we stamp with the shared turn id.
  userTurnSelector: '[data-testid="user-message"], .font-user-message',
  // Incognito-chat toggle in the launcher's top bar. The button carries no
  // stable testid or aria-label; its ghost SVG's left-eye path is the most
  // distinctive hook, with an aria-label scan as fallback.
  findPrivateButton() {
    const eye = document.querySelector('svg path[d^="M6.99951 8.66672"]');
    const byIcon = eye && eye.closest('button, [role="button"], a');
    if (byIcon) return byIcon;
    return Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'))
      .find(b => /incognito|private|temporary/i.test(b.getAttribute('aria-label'))) || null;
  },
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
