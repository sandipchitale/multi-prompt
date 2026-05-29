// Shared multi-prompt content-script logic.
//
// Each site script (claude.js, chatgpt.js, gemini.js) runs in the same
// isolated world as this file and calls MultiPrompt.init(config) with
// site-specific selectors and a newChat() routine. All of the cross-site
// behaviour (safe text injection, submission, echo-loop guarding and
// broadcast interception) lives here so it is defined exactly once.

(function () {
  // True while we are programmatically filling/submitting an editor, so the
  // broadcast interceptors below ignore the events our own injection produces.
  let isProgrammaticInput = false;

  // Per-page de-duplication so a single user submission is not broadcast twice
  // (e.g. by both the mousedown and click interceptors firing for one click).
  let lastBroadcastPrompt = '';
  let lastBroadcastTime = 0;

  function broadcastPrompt(prompt, source) {
    const now = Date.now();
    if (prompt === lastBroadcastPrompt && now - lastBroadcastTime < 1000) {
      return;
    }
    lastBroadcastPrompt = prompt;
    lastBroadcastTime = now;

    chrome.runtime.sendMessage(
      { action: 'broadcast_prompt', prompt: prompt, source: source },
      () => void chrome.runtime.lastError
    );
  }

  // Read the current draft text out of an editor (textarea, input or
  // contenteditable) without assuming which kind it is.
  function readPrompt(field) {
    const value = field.value != null ? field.value : field.innerText;
    return (value || '').trim();
  }

  // Set the editor text safely. For form controls we use the native value
  // setter so React notices the change; for contenteditable we build a
  // paragraph from a text node (never innerHTML) so prompts containing
  // "<", "&" or other markup are inserted verbatim instead of being parsed.
  function setEditorText(field, text) {
    field.focus();

    const tag = field.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(field, text);
    } else {
      field.replaceChildren();
      const p = document.createElement('p');
      p.textContent = text;
      field.appendChild(p);

      // Place the caret at the end so the wake-up insertText below appends.
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    field.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Submit the composer: click the site's send button, or fall back to an
  // Enter keypress on the editor. Used both when mirroring a prompt into a
  // target window and when sending the user's own prompt in the source window.
  function clickSendOrEnter(config, field) {
    const sendBtn = document.querySelector(config.sendSelector);
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      field.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        shiftKey: false,
        bubbles: true,
        cancelable: true
      }));
    }
  }

  // Fill the editor with the prompt and submit it. Retries while the SPA is
  // still mounting its editor, then submits via clickSendOrEnter. The injection
  // guard is released only once submission has actually been triggered, rather
  // than after a fixed timeout.
  function injectPrompt(config, prompt) {
    let attempts = 0;

    const tryInject = () => {
      const field = document.querySelector(config.inputSelector);
      if (!field) {
        if (attempts++ > 15) {
          isProgrammaticInput = false;
          return;
        }
        setTimeout(tryInject, 1000);
        return;
      }

      setEditorText(field, prompt);
      // Deprecated but still the most reliable nudge for rich editors
      // (ProseMirror/Lexical) to commit the change to their internal model.
      try { document.execCommand('insertText', false, ' '); } catch (e) { /* ignore */ }

      setTimeout(() => {
        clickSendOrEnter(config, field);
        setTimeout(() => { isProgrammaticInput = false; }, 500);
      }, 1000);
    };

    tryInject();
  }

  function init(config) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'inject_prompt') {
        isProgrammaticInput = true;
        injectPrompt(config, request.prompt);
        sendResponse({ success: true });
      } else if (request.action === 'new_chat') {
        config.newChat();
        sendResponse({ success: true });
      } else if (request.action === 'extract_chat_history') {
        const history = typeof config.extractHistory === 'function' ? config.extractHistory() : [];
        sendResponse({ success: true, history: history });
      }
    });

    // Intercept the user's Enter submission. We take over submission entirely
    // (preventing the site's own Enter handling) so this window and the
    // mirrored windows all submit through the same code path — some sites
    // otherwise broadcast correctly but fail to submit locally. Shift+Enter
    // (newline) and IME composition are left untouched.
    document.addEventListener('keydown', (e) => {
      if (isProgrammaticInput) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

      const field = e.target.closest(config.inputSelector);
      if (!field) return;

      const prompt = readPrompt(field);
      if (!prompt) return;

      e.preventDefault();
      e.stopPropagation();

      broadcastPrompt(prompt, config.source);

      isProgrammaticInput = true;
      clickSendOrEnter(config, field);
      setTimeout(() => { isProgrammaticInput = false; }, 500);
    }, true);

    const handleSendActivation = (e) => {
      if (isProgrammaticInput) return;
      if (!e.target.closest(config.sendSelector)) return;

      const field = document.querySelector(config.inputSelector);
      if (!field) return;

      const prompt = readPrompt(field);
      if (prompt) broadcastPrompt(prompt, config.source);
    };

    document.addEventListener('mousedown', handleSendActivation, true);
    document.addEventListener('click', handleSendActivation, true);
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const tagName = node.tagName;

    // Skip hidden elements, utility elements, copy buttons, buttons, svgs, etc.
    if (tagName === 'BUTTON' || tagName === 'SVG' || node.classList.contains('sr-only') || node.getAttribute('aria-hidden') === 'true') {
      return '';
    }

    const children = Array.from(node.childNodes).map(nodeToMarkdown).join('');

    switch (tagName) {
      case 'P':
        return '\n\n' + children.trim() + '\n\n';
      case 'STRONG':
      case 'B':
        return '**' + children + '**';
      case 'EM':
      case 'I':
        return '*' + children + '*';
      case 'CODE':
        if (node.parentNode && node.parentNode.tagName === 'PRE') {
          return children;
        }
        return '`' + children + '`';
      case 'PRE':
        const codeText = node.textContent || '';
        const codeClass = node.querySelector('code')?.className || '';
        const langMatch = codeClass.match(/language-(\w+)/);
        const lang = langMatch ? langMatch[1] : '';
        return '\n\n```' + lang + '\n' + codeText.replace(/^\s+|\s+$/g, '') + '\n```\n\n';
      case 'H1': return '\n\n# ' + children.trim() + '\n\n';
      case 'H2': return '\n\n## ' + children.trim() + '\n\n';
      case 'H3': return '\n\n### ' + children.trim() + '\n\n';
      case 'H4': return '\n\n#### ' + children.trim() + '\n\n';
      case 'H5': return '\n\n##### ' + children.trim() + '\n\n';
      case 'H6': return '\n\n###### ' + children.trim() + '\n\n';
      case 'UL':
      case 'OL':
        return '\n' + children + '\n';
      case 'LI':
        return '* ' + children.trim() + '\n';
      case 'BR':
        return '\n';
      case 'A':
        const href = node.getAttribute('href') || '';
        return `[${children}](${href})`;
      case 'BLOCKQUOTE':
        return '\n\n> ' + children.trim().replace(/\n/g, '\n> ') + '\n\n';
      case 'TABLE':
        return '\n\n' + formatTable(node) + '\n\n';
      default:
        return children;
    }
  }

  function formatTable(tableEl) {
    let markdown = '';
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const cellTexts = cells.map(cell => cell.textContent.trim().replace(/\|/g, '\\|'));
      markdown += '| ' + cellTexts.join(' | ') + ' |\n';
      if (rowIndex === 0) {
        markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
      }
    });
    return markdown;
  }

  function filterNestedElements(elements) {
    const arr = Array.from(elements);
    return arr.filter(el => {
      let parent = el.parentElement;
      while (parent) {
        if (arr.includes(parent)) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  globalThis.MultiPrompt = {
    init: init,
    nodeToMarkdown: (node) => nodeToMarkdown(node).replace(/\n{3,}/g, '\n\n'),
    filterNested: filterNestedElements
  };
})();
