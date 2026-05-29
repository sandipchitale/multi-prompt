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

    // Render each model's history
    Object.entries(history).forEach(([model, messages]) => {
      if (!messages || messages.length === 0) return;

      const meta = modelMeta[model] || { name: model, avatar: 'AI', class: model, avatarClass: '' };
      
      const section = document.createElement('section');
      section.className = `chatbot-section ${meta.class}`;

      section.innerHTML = `
        <div class="chatbot-header">
          <div class="chatbot-avatar ${meta.avatarClass}">${meta.avatar}</div>
          <div class="chatbot-name">${meta.name}</div>
        </div>
        <div class="messages-container"></div>
      `;

      const container = section.querySelector('.messages-container');

      messages.forEach(msg => {
        const isUser = msg.role === 'user';
        const msgEl = document.createElement('div');
        msgEl.className = `message ${isUser ? 'user' : 'assistant'}`;

        const roleName = isUser ? 'You' : meta.name;
        
        // Basic Markdown to HTML converter for simple rendering
        const rawContent = msg.text;
        const htmlContent = parseMarkdownToHtml(rawContent);

        msgEl.innerHTML = `
          <div class="message-role">${roleName}</div>
          <div class="message-content">${htmlContent}</div>
        `;
        container.appendChild(msgEl);
      });

      contentEl.appendChild(section);
    });

    if (contentEl.children.length === 0) {
      contentEl.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <h3>No conversations were found to export.</h3>
          <p>The chatbots do not have any message history in this session.</p>
        </div>
      `;
    } else {
      // Auto-trigger print after rendering
      setTimeout(() => {
        window.print();
      }, 600);
    }
  });
});

// Extremely simple parser for basic Markdown structures to display nicely in PDF
function parseMarkdownToHtml(md) {
  if (!md) return '';
  
  // Escape HTML entities to prevent execution of injection scripts, but keeping it safe
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (```lang ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

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
