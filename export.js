document.addEventListener('DOMContentLoaded', () => {
  // Set date
  const dateEl = document.getElementById('export-date');
  const now = new Date();
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
  }

  // Bind close/print button clicks (inline onclick is blocked by CSP in MV3)
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => window.close());
  }

  const printBtn = document.getElementById('print-btn');
  if (printBtn) {
    printBtn.addEventListener('click', () => window.print());
  }

  // Retrieve chat history
  chrome.storage.local.get(['lastExportedHistory', 'themePref'], (result) => {
    const history = result.lastExportedHistory;
    const theme = result.themePref || 'auto';
    
    // Match theme
    if (theme !== 'auto') {
      document.documentElement.setAttribute('data-theme', theme);
    }

    if (!history || Object.keys(history).length === 0) {
      const contentEl = document.getElementById('chat-content');
      if (contentEl) {
        contentEl.innerHTML = `
          <div style="text-align: center; padding: 40px; color: var(--text-muted);">
            <h3>No conversations were found to export.</h3>
            <p>Make sure you have tiled chatbot windows with active messages inside them.</p>
          </div>
        `;
      }
      return;
    }

    const contentEl = document.getElementById('chat-content');
    if (!contentEl) return;
    contentEl.innerHTML = ''; // Clear loader

    const modelMeta = {
      gemini: { name: 'Gemini', avatar: 'G', class: 'gemini', avatarClass: 'gemini-avatar' },
      claude: { name: 'Claude', avatar: 'C', class: 'claude', avatarClass: 'claude-avatar' },
      chatgpt: { name: 'ChatGPT', avatar: 'GPT', class: 'chatgpt', avatarClass: 'chatgpt-avatar' }
    };

    // Render interleaved prompts and responses
    const alignedTurns = alignHistory(history);

    alignedTurns.forEach(turn => {
      // Create a .prompt-group container
      const groupEl = document.createElement('div');
      groupEl.className = 'prompt-group';

      // 1. User Prompt Card (Only display if it's not empty, or display a styled empty block if greeting)
      if (turn.prompt || Object.keys(turn.responses).length > 0) {
        if (turn.prompt) {
          const promptEl = document.createElement('div');
          promptEl.className = 'user-prompt-card';
          const parsedPrompt = parseMarkdownToHtml(turn.prompt);
          promptEl.innerHTML = `
            <h2 class="message-role">You</h2>
            <div class="message-content">${parsedPrompt}</div>
          `;
          groupEl.appendChild(promptEl);
        }

        // 2. Responses Container
        const responsesContainer = document.createElement('div');
        responsesContainer.className = 'responses-container';

        // For each model in our history, if there is a response, render it
        Object.entries(turn.responses).forEach(([model, responseText]) => {
          if (!responseText) return;
          
          const meta = modelMeta[model] || { name: model, avatar: 'AI', class: model, avatarClass: '' };
          
          const cardEl = document.createElement('div');
          cardEl.className = `response-card ${meta.class}`;
          
          const htmlContent = parseMarkdownToHtml(responseText);
          
          cardEl.innerHTML = `
            <div class="response-header">
              <div class="chatbot-avatar ${meta.avatarClass}" aria-hidden="true">${meta.avatar}</div>
              <h3 class="chatbot-name">${meta.name}</h3>
            </div>
            <div class="response-content">${htmlContent}</div>
          `;
          responsesContainer.appendChild(cardEl);
        });

        groupEl.appendChild(responsesContainer);
        contentEl.appendChild(groupEl);
      }
    });

    if (contentEl.children.length === 0) {
      contentEl.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <h3>No conversations were found to export.</h3>
          <p>The chatbots do not have any message history in this session.</p>
        </div>
      `;
    }
    // The user invokes printing via the "Print / Save as PDF" button.
  });
});

// Extremely simple parser for basic Markdown structures to display nicely in PDF
function parseMarkdownToHtml(md) {
  if (!md) return '';
  
  // Escape HTML entities to prevent injection. Quotes are escaped too so that a
  // URL inside a crafted [text](url) link cannot break out of the href="" we
  // build below and inject an event-handler attribute (DOM-based XSS).
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Code blocks (```lang ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links ([text](url)) — only http(s) URLs, so a crafted javascript: URL in a
  // chat response can never become a clickable link in the export.
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Headings (e.g. ### Title)
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

  // Simple formatting of newlines to Paragraphs/BRs if not inside PRE
  // Splits by pre blocks and formats paragraphs in between
  const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/);
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('<pre>')) {
      parts[i] = parts[i]
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
      
      // Wrap in paragraph if it has content and doesn't start with heading/blockquote/list
      if (parts[i].trim()) {
        parts[i] = '<p>' + parts[i] + '</p>';
      }
    }
  }
  html = parts.join('');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

// getChatbotTurns / promptsMatch / alignHistory live in align.js (shared with
// popup.js), loaded before this file by export.html.
