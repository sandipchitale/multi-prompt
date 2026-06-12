// Gemini (gemini.google.com) – site-specific configuration for the shared
// multi-prompt content script in common.js.
MultiPrompt.init({
  source: 'gemini',
  // Gemini wraps its composer in a custom <rich-textarea> element.
  inputSelector: 'rich-textarea div[contenteditable="true"], .ProseMirror, div[contenteditable="true"]',
  sendSelector: 'button[aria-label*="Send message"], .send-button',
  // The rendered user-query element we stamp with the shared turn id.
  userTurnSelector: 'user-query',
  // Temporary-chat toggle in the launcher's top bar. The clickable control is
  // the button wrapping the distinctive gemini_chat_temp Material icon.
  findPrivateButton() {
    const icon = document.querySelector(
      'mat-icon[data-mat-icon-name="gemini_chat_temp"], mat-icon[fonticon="gemini_chat_temp"]'
    );
    return icon ? icon.closest('button, [role="button"]') : null;
  },
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
  },
  extractHistory() {
    const history = [];
    const rawElements = document.querySelectorAll('user-query, .query-text, message-content, .message-content');
    const elements = MultiPrompt.filterNested(rawElements);
    elements.forEach(el => {
      const isUser = el.tagName === 'USER-QUERY' || el.classList.contains('query-text');
      if (isUser) {
        let text = el.innerText.trim();
        // Remove screen-reader friendly prefix "You said"
        if (text.startsWith("You said\n") || text.startsWith("You said")) {
          text = text.replace(/^You said\s*/i, "").trim();
        }
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
