# [Multi-Prompt](https://www.linkedin.com/pulse/multi-prompt-sandip-chitale-0ktrc) Chrome (and Safari) Extension 🚀

The Multi-Prompt extension is a productivity tool that tiles Gemini, Claude, and ChatGPT side-by-side on your screen and synchronizes your prompts across all of them.

Instead of typing prompts inside an extension panel, you type and submit a prompt in **any** of the tiled chatbot windows, and the extension automatically broadcasts and submits that same prompt in all other active chatbot windows.

## Features ✨

- **Multi-Model Support:** Select any combination of Gemini, Claude, and ChatGPT (from 1 to all 3).
- **Prompt Broadcasting:** Type your prompt natively in Claude, Gemini, or ChatGPT and it is replicated and submitted in the other tiled windows.
- **One-Button "New Chat":** A single button is all you need. If the selected chatbots aren't tiled yet, **New Chat** opens and tiles them side-by-side; if they're already open, it starts a fresh conversation in each. Either way it begins a brand new, automatically-saved session.
- **Exact Cross-Model Alignment:** Each broadcast is stamped with a shared, hidden **turn id** (a `data-mp-turn` DOM attribute added _after_ the message is sent — never injected into the prompt text the model sees). Export uses these ids to group every model's answer to the same prompt exactly, even when two prompts are textually identical.
- **Automatic Session Bookmarking:** Every session is auto-saved into a timestamped subfolder under a `"Multi-prompt"` parent folder in Chrome Bookmarks — no manual "bookmark" step. A small bookkeeping bookmark inside each folder stores the window order and the turn-id ledger (it uses the reserved `multi-prompt.invalid` host, so it can never navigate anywhere, and the extension skips it when reopening).
- **Saved Sessions Picker:** Reopen any saved session from a compact dropdown in the popup. The extension re-tiles the saved conversations in order and **reattaches** the original turn ids, so exported alignment survives a reload. Delete a session (and its bookmark folder) from the same control.
- **Visual Tiling Order & Drag-to-Reorder:** Select chatbots and arrange their left-to-right window order from one side-by-side row in the popup. Dragging a card to a new position physically slides the open windows on screen to match — without page reloads or losing your chat state.
- **Export Chat History:** Export conversation history from all active chatbots into Markdown (`.md`) or a clean PDF / print template. The PDF view renders immediately and you invoke **Print / Save as PDF** when ready (no surprise print dialog).
- **Close Tiles:** Close all active, extension-managed tiled windows instantly with a single button click.
- **Selective Syncing:** Only prompts typed inside extension-managed tiled windows are synchronized. Chatbots you open yourself in normal tabs are ignored.
- **Theme:** Auto / Light / Dark, following the system theme by default.

## How It Works ⚙️

Because AI chatbots enforce strict security policies, this extension combines a **Background Service Worker** with **Content Scripts**:

1. The **Popup** (`popup.html` / `popup.js`) is the dashboard for selecting active models, ordering them, exporting, and reopening saved sessions. Selections, order, and theme are persisted in `chrome.storage.local`.
2. The **Service Worker** (`background.js`) is the coordinator. It tiles/swaps/resets windows, tracks the managed windows and the **active session** in `chrome.storage.session`, mints a shared **turn id** for each broadcast, and manages the session bookmark folders.
3. **Content Scripts** are injected into the chatbot pages. A shared module (`content/common.js`) holds all the cross-site logic, while the per-site files (`content/claude.js`, `content/chatgpt.js`, `content/gemini.js`) supply only that site's CSS selectors, "new chat" behaviour, and history extraction.
4. When you submit a prompt in a managed window, its content script forwards the text to the service worker, which verifies the source window is managed, mints a turn id, appends it to the session ledger, and forwards the prompt (with the turn id) to the other selected models.
5. Target content scripts insert the text (using safe, framework-aware insertion — never `innerHTML`), trigger the site's submit handler, and **tag the freshly rendered turn** with the shared turn id via a `data-mp-turn` attribute (repaired by a `MutationObserver` if the site re-renders).
6. **Sessions are durable.** Each session is an auto-created bookmark folder whose per-model bookmarks are kept pointed at the live conversation URLs as they stabilise (e.g. `claude.ai/new` → `claude.ai/chat/<id>`), plus a bookkeeping bookmark holding the order and turn-id ledger. Reopening a session from the popup re-tiles those URLs and **reattaches** the ids to the reloaded turns so alignment is preserved.
7. **Export** asks every managed content script for its history (each user turn carries its `data-mp-turn` id), then groups answers across models **by turn id**, falling back to fuzzy prompt matching only for untagged turns.

## Permissions

- `tabs`, `windows` — to find, position, resize, and swap the chatbot windows.
- `storage` — to persist preferences (`local`) and the set of managed window IDs (`session`).
- `bookmarks` — to automatically save each session as a timestamped folder (plus a bookkeeping bookmark) under the Bookmarks Bar, and to list/reopen/delete saved sessions.
- `host_permissions` for `gemini.google.com`, `claude.ai`, and `chatgpt.com` — to run the content scripts on those sites only.

## Installation from Source 💻

### Chrome

Since this is an unpacked developer extension, you can install it in a few seconds:

1. **Download/Clone the Source:** Save this `multi-prompt` folder somewhere on your computer.
2. **Open Chrome Extensions:** Go to `chrome://extensions/`.
3. **Enable Developer Mode:** Toggle **Developer mode** on (top right).
4. **Load Unpacked:** Click **Load unpacked**.
5. **Select the Folder:** Choose the `multi-prompt` folder (the directory containing `manifest.json`).
6. **Pin It:** Click the puzzle-piece icon next to the address bar and pin "Multi-Prompt".

### Safari

Multi-prompt works on Safari as well. To install follow the instructions [here](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension#Temporarily-install-a-web-extension-folder-in-macOS-Safari).

Enjoy supercharged multi-AI prompting!

## One-Shot Prompt (Generate from Scratch) 🤖

If you want to generate this exact implementation from scratch using a modern AI model, you can use the following comprehensive prompt:

```text
Write a fully-functional, polished Manifest V3 Chrome Extension called "Multi-Prompt Split View" that tiles Gemini, Claude, and ChatGPT side-by-side and synchronizes prompts across all of them in real-time. Each broadcast is stamped with a shared, hidden per-turn id (a `data-mp-turn` DOM attribute added after the message is sent, never injected into the prompt) so exported history can be aligned across models exactly — even for identical prompts. Every session is automatically saved as a Chrome bookmark folder and can be reopened (re-tiled, with alignment reattached) from a Saved Sessions picker. The code must implement modern styling (glassmorphism/sleek dark/light theme support) and robust event orchestration.

Create the extension using the following file structure:
- manifest.json
- background.js
- popup.html
- popup.css
- popup.js
- content/common.js
- content/gemini.js
- content/claude.js
- content/chatgpt.js
- export.html
- export.js

Here are the specifications for each file:

### 1. manifest.json
- Manifest version: 3
- Permissions: "tabs", "windows", "storage", "bookmarks"
- Host permissions: `*://gemini.google.com/*`, `*://claude.ai/*`, `*://chatgpt.com/*`
- Action default popup: popup.html
- Background service worker: background.js
- Content scripts configuration:
  - Match `*://gemini.google.com/app*` using content/common.js and content/gemini.js
  - Match `*://claude.ai/*` using content/common.js and content/claude.js
  - Match `*://chatgpt.com/*` using content/common.js and content/chatgpt.js
  - Run at `document_idle`

### 2. background.js
- Maintain chatbot base URLs: Gemini (`https://gemini.google.com/app`), Claude (`https://claude.ai/new`), ChatGPT (`https://chatgpt.com/`).
- Tab-to-Model matching by hostname. Detect "stabilised" conversation URLs per model (e.g. Claude `/chat/<id>`, ChatGPT `/c/<id>`, Gemini `/app/<id>`) vs the blank launcher.
- Track "managed window IDs" and an "active session" in `chrome.storage.session`. The active session links the live windows to their bookmark folder and carries the working copy of the turn-id ledger. On `chrome.windows.onRemoved`, drop the window id (and clear the session when its last window closes).
- Mint a unique, roughly time-ordered **turn id** per broadcast (`generateTurnId`). The same id is handed to the source and all injection targets so their rendered turns can be matched exactly.
- On `chrome.tabs.onUpdated`, when a managed model tab's URL stabilises, update that model's session bookmark to point at the live permalink.
- Message listeners:
  - `new_chat`: The single entry point. If the selected models are already tiled, re-tile them and trigger a fresh conversation in each; otherwise open fresh tiled windows. Either way, rotate to a brand new auto-saved session (new bookmark folder).
  - `rearrange_tiles`: Re-tile the open managed windows to match a new left-to-right model order (from a drag-and-drop reorder in the popup). Collects the windows' current geometry slots, sorts them left-to-right, and reassigns each model to the slot at its new index. Keep the session's recorded order in sync.
  - `broadcast_prompt`: Verify the source window is managed, mint a turn id, append `{id, prompt-prefix}` to the session ledger (persisted into the meta bookmark), and forward the prompt + turn id to all other managed models. Respond to the sender with the turn id so it can tag its own turn.
  - `export_chats`: Query chat history from content scripts of all managed models and return it (each user turn includes its `data-mp-turn` id).
  - `close_tiles`: Close all extension-managed tiled windows and clear managed-window + active-session storage.
  - `list_sessions` / `open_session` / `delete_session`: Enumerate saved session folders; reopen one (re-tile its saved URLs in order and send `reattach_turns` with the ledger to each tab); or remove a session's bookmark folder.
- **Auto-bookmarking:** Every session creates a timestamped subfolder under a `"Multi-prompt"` parent folder (Bookmarks Bar). Inside it, create one bookmark per model (kept pointed at the live URL) and a "bogus" bookkeeping bookmark on the reserved `multi-prompt.invalid` host whose URL encodes the model order + turn-id ledger as JSON. The extension recognises and skips this bookmark when reopening.

### 3. popup.html
- Clean container of fixed width (~560px, wide enough that saved-session labels fit without truncation).
- Premium header with a stylized "M" logo gradient and Title "Multi-Prompt".
- A Theme Toggle (Auto, Light, Dark) using radio inputs.
- A single side-by-side row of draggable cards for Gemini, Claude, and ChatGPT (rendered dynamically), with a swap button between adjacent cards. Each card has a toggle indicator and a drag handle. The cards sit left-to-right to mirror the window tiling: their order **is** the tile order. Click a card to select/deselect it (deselected cards stay in the row, dimmed, and are ignored when tiling); reorder either by dragging a card or by clicking the swap button between two cards. This merges the former "Select active Chatbots" checklist and the separate "Window Tile Order" preview into one control.
- Primary actions row: "New Chat" and "Close Tiles" buttons (no separate "Tile Windows" or "Bookmark" buttons — New Chat tiles on demand and bookmarking is automatic).
- Export Chat History section: dropdown choice between "Markdown (.md)" or "PDF / Print (.pdf)" and an Export button.
- Saved Sessions section: a compact `<select>` dropdown listing saved sessions (`timestamp — Gemini / Claude / ChatGPT`) with adjacent "Open" and "✕" (delete) buttons, enabled only when a session is selected.
- State-driven styling: show/hide error messages if no models are checked. Disable actions appropriately.

### 4. popup.css
- Custom fonts (e.g., Inter) and responsive CSS custom properties (colors, borders, gradients).
- Theme styling: Light and Dark modes. Dark uses deep black/navy background `#0f111a` and panel background `#161925`. Light uses off-white `#f7f9fa` and white panels.
- Side-by-side selectable cards (one per model) laid out in a horizontal row, each with the model name and a toggle switch on a single line plus a drag handle, and a small swap button between adjacent cards. Selected cards highlight their border; deselected cards are dimmed; drop indicators show where a dragged card will land.
- Elegant button states (hover, active, disabled) using smooth color transitions.

### 5. popup.js
- Listen to DOMContentLoaded. Read and apply stored theme (Auto/Light/Dark), checklist checkboxes, and export format choices from storage.
- Synchronize theme settings with OS system theme when set to 'auto'.
- Dynamically build and render the row of model cards from the saved order, inserting a swap button between adjacent cards. Clicking a card toggles its selection; dragging a card or clicking a swap button reorders it. Each reorder saves the new order to storage and (when windows are already tiled) posts `rearrange_tiles` to physically re-tile the open windows to match.
- "New Chat" sends `new_chat` with the selected models and screen geometry (tile-if-needed + fresh chat). Set disabled states for Close Tiles / Export based on background session state.
- Saved Sessions: request the list from the background, populate the dropdown, and wire Open (`open_session`) and Delete (`delete_session`); refresh the list after New Chat / Close Tiles / delete.
- Handle Markdown/PDF export action: request histories from the background worker, align chatbot turns **by shared turn id** (falling back to fuzzy prompt matching for untagged turns), and output the chosen format (save the markdown string as a file download, or save history to local storage and open export.html).

### 6. content/common.js
- Encapsulate prompt broadcast, content injection, echo prevention, turn tagging, and history extraction in a global `MultiPrompt` object.
- Maintain programmatic flags (`isProgrammaticInput = false`) and de-duplication buffers to avoid loop-back echoes or double broadcasts.
- Value setters: Set editor text (Textarea, Input, or ContentEditable) safely using descriptors, append content/events safely, dispatch React/framework-aware events ('input' and 'change').
- **Turn tagging:** After any submission, find the freshly rendered user-message element (snapshot before, diff after) and stamp it with a `data-mp-turn` attribute carrying the shared turn id. Keep a registry and a `MutationObserver` that re-applies the attribute if the framework strips it on re-render. The id is added _after_ send, so it is never part of the prompt the model receives.
- Message listener:
  - `inject_prompt`: Set the editor text, nudge rich editors with `document.execCommand('insertText')`, wait briefly, click send (or dispatch Enter), then tag the new turn with `request.turnId`.
  - `new_chat`: Clear the tagged-turn registry and execute site-specific newChat logic.
  - `reattach_turns`: For a reloaded (bookmarked) conversation, wait for the history to render, then re-stamp the user turns in order with the ledger's turn ids.
  - `extract_chat_history`: Execute site-specific DOM parsing, mapping HTML to markdown (P, strong, code blocks, blockquotes, lists, tables); include each user turn's `data-mp-turn` id.
- Keydown listener on `document`: Intercept Enter keypresses on target editors (ignoring Shift/IME/programmatic values), prevent default behaviors, broadcast text (receiving the turn id back), submit, and tag the local turn.
- Click/Mousedown listener: Detect clicks on send buttons, extract content, broadcast, and tag the local turn.

### 7. content/gemini.js, claude.js, chatgpt.js
- Invoke `MultiPrompt.init({...})` passing site selectors and callbacks.
- Selectors (each also provides a `userTurnSelector` — the rendered user-message element to stamp with the turn id):
  - Gemini: input `rich-textarea div[contenteditable="true"], .ProseMirror`, send `button[aria-label*="Send message"], .send-button`, user turn `user-query`. New chat clicks the "New Chat" link/button or redirects to homepage.
  - Claude: input `.ProseMirror, div[contenteditable="true"]`, send `button[aria-label*="Send"], button[data-testid="send-button"]`, user turn `[data-testid="user-message"], .font-user-message`. New chat clicks `/new` link or redirects.
  - ChatGPT: input `#prompt-textarea, div[contenteditable="true"]`, send `button[data-testid="send-button"]`, user turn `[data-message-author-role="user"]`. New chat clicks new-chat buttons or redirects.
- Extraction rules: Iterate user prompts and assistant message containers, strip screen-reader prefixes (like "You said"), parse formatting, read each user turn's `data-mp-turn` id, and compile history turns.

### 8. export.html & export.js
- Standalone HTML page with styling for printing/saving to PDF, plus an action bar with "Close Window" and "Print / Save as PDF" buttons.
- Theme support matching current user preference.
- Retrieve exported history from storage, align turns **by shared turn id** (same logic as the popup; fuzzy fallback for untagged turns), and render user prompt blocks stacked with response cards colored by brand.
- Render markdown elements into standard HTML using a simple custom markdown regex parser.
- Do **not** auto-print — the user invokes printing via the "Print / Save as PDF" button.

Provide code implementations that are robust, error-tolerant, and handle corner cases gracefully. Avoid using placeholders or simplified loops.
```
