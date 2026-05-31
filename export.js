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
            <div class="message-role">You</div>
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
              <div class="chatbot-avatar ${meta.avatarClass}">${meta.avatar}</div>
              <div class="chatbot-name">${meta.name}</div>
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

// Group a single model's history into turns: { prompt, response }
function getChatbotTurns(messages) {
  const turns = [];
  let currentTurn = null;

  messages.forEach(msg => {
    const msgText = (msg.text || '').trim();
    if (msg.role === 'user') {
      if (currentTurn && currentTurn.response) {
        turns.push(currentTurn);
        currentTurn = null;
      }
      if (!currentTurn) {
        currentTurn = { prompt: msgText, response: '', turnId: msg.turnId || null };
      } else {
        currentTurn.prompt += '\n\n' + msgText;
        if (!currentTurn.turnId && msg.turnId) currentTurn.turnId = msg.turnId;
      }
    } else if (msg.role === 'assistant') {
      if (!currentTurn) {
        currentTurn = { prompt: '', response: msgText };
      } else {
        if (!currentTurn.response) {
          currentTurn.response = msgText;
        } else {
          currentTurn.response += '\n\n' + msgText;
        }
      }
    }
  });
  if (currentTurn) {
    currentTurn.prompt = currentTurn.prompt.trim();
    currentTurn.response = currentTurn.response.trim();
    turns.push(currentTurn);
  }
  return turns;
}

// Compare prompt texts ignoring whitespace and case
function promptsMatch(p1, p2) {
  if (!p1 && !p2) return true;
  if (!p1 || !p2) return false;

  const clean = (text) => {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
  };

  const c1 = clean(p1);
  const c2 = clean(p2);

  if (c1 === c2) return true;

  if (c1.length > 20 && c2.length > 20) {
    if (c1.startsWith(c2) || c2.startsWith(c1)) return true;
  }

  return false;
}

// Align history across all chatbots.
//
// Turns broadcast by the extension carry a shared turnId stamped onto every
// model's rendered turn, so they are grouped exactly by that id — even when two
// prompts are textually identical. Turns without an id (e.g. typed before
// tiling, or where tagging failed) fall back to the fuzzy prompt-text match.
function alignHistory(history) {
  const modelTurns = {};
  Object.keys(history).forEach(model => {
    modelTurns[model] = getChatbotTurns(history[model]);
  });

  const alignedTurns = [];
  const byTurnId = new Map();

  Object.keys(modelTurns).forEach(model => {
    modelTurns[model].forEach((turn, idx) => {
      let matched = null;
      if (turn.turnId && byTurnId.has(turn.turnId)) {
        matched = byTurnId.get(turn.turnId);
      } else {
        // Find the earliest bucket this model hasn't filled yet whose prompt
        // matches and whose id is compatible. "Compatible" means at least one
        // side is untagged, or both ids are equal — so an untagged turn (e.g. a
        // model that lost its tag) still merges into a tagged group, while two
        // DIFFERENT ids never merge (keeping identical prompts separate).
        matched = alignedTurns.find(item =>
          !(model in item.responses) &&
          (item.turnId == null || turn.turnId == null || item.turnId === turn.turnId) &&
          promptsMatch(item.prompt, turn.prompt)
        );
      }

      if (!matched) {
        matched = { prompt: turn.prompt, responses: {}, turnId: null, indices: [] };
        alignedTurns.push(matched);
      }
      if (turn.turnId && matched.turnId == null) {
        matched.turnId = turn.turnId;
        byTurnId.set(turn.turnId, matched);
      }
      if (turn.prompt.length > matched.prompt.length) matched.prompt = turn.prompt;

      matched.responses[model] = turn.response;
      matched.indices.push(idx);
    });
  });

  // Calculate average index for sorting
  alignedTurns.forEach(turn => {
    const sum = turn.indices.reduce((a, b) => a + b, 0);
    turn.avgIndex = sum / turn.indices.length;
  });

  // Sort aligned turns chronologically by average index
  alignedTurns.sort((a, b) => a.avgIndex - b.avgIndex);

  // Clean up bookkeeping properties
  alignedTurns.forEach(turn => {
    delete turn.indices;
    delete turn.avgIndex;
    delete turn.turnId;
  });

  return alignedTurns;
}
