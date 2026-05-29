// Gemini (gemini.google.com) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'gemini',
  // Gemini wraps its composer in a custom <rich-textarea> element.
  inputSelector: 'rich-textarea div[contenteditable="true"], .ProseMirror, div[contenteditable="true"]',
  sendSelector: 'button[aria-label*="Send message"], .send-button',
  newChat() {
    let newChatBtn = null;

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
      window.location.href = 'https://gemini.google.com/app';
    }
  }
});
