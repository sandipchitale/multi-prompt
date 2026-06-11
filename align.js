// Shared cross-model history alignment, loaded by both popup.html (Markdown
// export) and export.html (PDF/print export) so the grouping logic is defined
// exactly once.

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
// tiling, or where tagging failed) fall back to the fuzzy prompt-text match so
// nothing is silently dropped.
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

// Render aligned history as Markdown. Shared by the popup's Markdown export and
// the workspace bar's Export.
function generateMarkdown(history) {
  let md = `# Multi-Prompt Conversation Export\n`;
  md += `Exported on: ${new Date().toLocaleString()}\n\n`;
  md += `---\n\n`;

  const modelNames = { gemini: 'Gemini', claude: 'Claude', chatgpt: 'ChatGPT' };
  const alignedTurns = alignHistory(history);

  alignedTurns.forEach(turn => {
    if (turn.prompt || Object.keys(turn.responses).length > 0) {
      if (turn.prompt) {
        md += `## 👤 Prompt\n${turn.prompt}\n\n`;
      }
      Object.entries(turn.responses).forEach(([model, responseText]) => {
        if (!responseText) return;
        const name = modelNames[model] || model;
        md += `### 🤖 ${name}\n${responseText}\n\n`;
      });
      md += `---\n\n`;
    }
  });

  return md;
}

// Deliver an aligned history in the chosen format: download Markdown, or hand
// the history to export.html for the print/PDF view. Shared by the popup and
// the workspace Export button (both run in extension pages with chrome.* APIs).
function deliverExport(history, format) {
  if (format === 'pdf') {
    chrome.storage.local.set({ lastExportedHistory: history }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
    });
  } else {
    const dateStr = new Date().toISOString().slice(0, 10);
    downloadFile(generateMarkdown(history), `multi-prompt-chats-${dateStr}.md`, 'text/markdown');
  }
}

// Trigger a browser download of an in-memory string. Safari cannot resolve
// blob: URLs minted by extension pages (it navigates to the blob and dies with
// "WebKitBlobResource error 1"), so there the content travels inline in a
// data: URL instead; everywhere else a blob avoids the URL-length encoding.
function downloadFile(content, filename, contentType) {
  const isSafariExtensionPage = location.protocol === 'safari-web-extension:';
  const url = isSafariExtensionPage
    ? 'data:' + contentType + ';charset=utf-8,' + encodeURIComponent(content)
    : URL.createObjectURL(new Blob([content], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (!isSafariExtensionPage) URL.revokeObjectURL(url);
}
