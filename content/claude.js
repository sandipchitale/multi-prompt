// Claude (claude.ai) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'claude',
  // Claude uses a ProseMirror contenteditable for its composer.
  inputSelector: '.ProseMirror, div[contenteditable="true"]',
  sendSelector: 'button[aria-label*="Send"], button[data-testid="send-button"]',
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
  }
});
