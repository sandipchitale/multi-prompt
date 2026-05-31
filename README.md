# [Multi-Prompt](https://www.linkedin.com/pulse/multi-prompt-sandip-chitale-0ktrc) Chrome (and Safari) Extension 🚀

The Multi-Prompt extension is a productivity tool that tiles Gemini, Claude, and ChatGPT side-by-side on your screen and synchronizes your prompts across all of them.

Instead of typing prompts inside an extension panel, you type and submit a prompt in **any** of the tiled chatbot windows, and the extension automatically broadcasts and submits that same prompt in all other active chatbot windows.

## Features ✨

- **Multi-Model Support:** Select any combination of Gemini, Claude, and ChatGPT (from 1 to all 3).
- **Prompt Broadcasting:** Type your prompt natively in Claude, Gemini, or ChatGPT and it is replicated and submitted in the other tiled windows.
- **Smart "Tile Windows":** Click "Tile Windows" in the popup to position and size the selected chatbots side-by-side across your screen. Existing chatbot tabs are reused (and pulled into their own window if needed) rather than duplicated.
- **Visual Tiling Order & Swapping:** Arrange the left-to-right window order directly from the popup. Swapping physically slides the windows on screen without page reloads or losing your chat state.
- **Master "New Chat" Control:** Start fresh threads on all active models at once with a single click.
- **Bookmark Session:** Bookmark your active chatbot session tabs into a timestamped subfolder under a `"Multi-prompt"` parent folder inside Chrome Bookmarks. Reloading these bookmarked conversations and clicking "Tile Windows" will tile them back perfectly.
- **Export Chat History:** Export conversation history from all active chatbots into Markdown (`.md`) or save to PDF / print via a clean export template.
- **Close Tiles:** Close all active, extension-managed tiled windows instantly with a single button click.
- **Selective Syncing:** Only prompts typed inside extension-managed tiled windows are synchronized. Chatbots you open yourself in normal tabs are ignored.
- **Theme:** Auto / Light / Dark, following the system theme by default.

## How It Works ⚙️

Because AI chatbots enforce strict security policies, this extension combines a **Background Service Worker** with **Content Scripts**:

1. The **Popup** (`popup.html` / `popup.js`) is the configuration dashboard for selecting active models, ordering them, and tiling them. Selections, order, and theme are persisted in `chrome.storage.local`.
2. The **Service Worker** (`background.js`) tiles, swaps, and resets the chatbot windows, and tracks which windows it manages in `chrome.storage.session`.
3. **Content Scripts** are injected into the chatbot pages. A shared module (`content/common.js`) holds all the cross-site logic, while the per-site files (`content/claude.js`, `content/chatgpt.js`, `content/gemini.js`) supply only that site's CSS selectors and "new chat" behaviour.
4. When you submit a prompt in a managed window, its content script forwards the text to the service worker, which verifies the source window is managed and forwards the prompt to the other selected models.
5. Target content scripts insert the text (using safe, framework-aware insertion — never `innerHTML`) and trigger the site's submit handler.

## Permissions

- `tabs`, `windows` — to find, position, resize, and swap the chatbot windows.
- `storage` — to persist preferences (`local`) and the set of managed window IDs (`session`).
- `bookmarks` — to create a folder hierarchy and save session links under the Bookmarks Bar.
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
Write a fully-functional, polished Manifest V3 Chrome Extension called "Multi-Prompt Split View" that tiles Gemini, Claude, and ChatGPT side-by-side and synchronizes prompts across all of them in real-time. The code must implement modern styling (glassmorphism/sleek dark/light theme support) and robust event orchestration.

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
- Tab-to-Model matching: Compare tab URLs hostnames. To score matching tabs, prioritize active tabs and specific chat paths over homepages.
- Manage "managed window IDs" in `chrome.storage.session`. Remove window IDs from storage when the window is closed (`chrome.windows.onRemoved`).
- Message listeners:
  - `launch_tabs`: Tile selected chatbots horizontally across the available screen area. If an existing tab for a model is open, reuse it (if it's the only tab in a window, resize/move that window; otherwise extract it to a new window). If none exists, create a new window.
  - `new_chat`: Send a message to active chatbot tabs to trigger a fresh conversation.
  - `swap_tabs`: Swap positions of two tiled windows by swapping their window dimensions/coordinates. If they are in the same window (e.g. tabs), swap their URLs instead.
  - `broadcast_prompt`: Intercept a prompt from a managed tab and send it to all other managed active tabs, avoiding echoes.
  - `export_chats`: Query chat history from content scripts of all active models in the managed session and return it.
  - `close_tiles`: Close all extension-managed tiled windows and clear the storage.
  - `bookmark_session`: Find all chatbot tabs in the session, search/create a "Multi-prompt" bookmarks folder under Bookmarks Bar, create a timestamped subfolder, and bookmark each active chatbot URL.

### 3. popup.html
- Clean container of fixed width (380px).
- Premium header with a stylized "M" logo gradient and Title "Multi-Prompt".
- A Theme Toggle (Auto, Light, Dark) using radio inputs.
- Checklist card container for Gemini, Claude, and ChatGPT with toggle indicators.
- A dynamically filled Layout Preview section showing selected models in left-to-right order with interactive swap buttons (bidirectional arrows) between chips. Clicking a swap button updates storage and messages the background script to swap window coordinates.
- Export Chat History section: dropdown choice between "Markdown (.md)" or "PDF / Print (.pdf)" and an Export button.
- Bottom actions: Row 1 containing "New Chat" and "Bookmark" buttons; Row 2 containing "Tile Windows" and "Close Tiles" buttons.
- State-driven styling: show/hide error messages if no models are checked. Disable actions appropriately.

### 4. popup.css
- Custom fonts (e.g., Inter) and responsive CSS custom properties (colors, borders, gradients).
- Theme styling: Light and Dark modes. Dark uses deep black/navy background `#0f111a` and panel background `#161925`. Light uses off-white `#f7f9fa` and white panels.
- Custom styled checkboxes masqueraded as premium cards with subtle transitions, card borders highlighting upon checkbox activation, and neon colored avatars (Gemini: blue gradient, Claude: orange, ChatGPT: emerald).
- Tiling order preview chips with rounded edges and transition effects on the swap arrows.
- Elegant button states (hover, active, disabled) using smooth color transitions.

### 5. popup.js
- Listen to DOMContentLoaded. Read and apply stored theme (Auto/Light/Dark), checklist checkboxes, and export format choices from storage.
- Synchronize theme settings with OS system theme when set to 'auto'.
- Dynamically build and render the Layout Preview chips with swap controls. Clicking a swap control swaps indices in the list, saves to storage, and posts a message to trigger window physical swapping.
- Set disabled states for action buttons (Bookmark, Close Tiles, Export) dynamically based on background session state.
- Handle Markdown/PDF export action: request histories from background worker, align chatbot turns chronologically using matching heuristics (comparing user prompts with tolerance for minor spacing/casing mismatches), and output format (either save markdown string as a file download, or save history to local storage and open export.html).

### 6. content/common.js
- Encapsulate prompt broadcast, content injection, echo prevention, and history extraction in a global `MultiPrompt` object.
- Maintain programmatic flags (`isProgrammaticInput = false`) and de-duplication buffers to avoid loop-back echoes or double broadcasts.
- Value setters: Set editor text (Textarea, Input, or ContentEditable) safely using descriptors, append content/events safely, dispatch React/framework-aware events ('input' and 'change').
- Message listener:
  - `inject_prompt`: Call editor setting logic, nudge the editor model using `document.execCommand('insertText')`, wait briefly, then click the send button (or dispatch Enter).
  - `new_chat`: Execute site-specific newChat logic.
  - `extract_chat_history`: Execute site-specific DOM parsing and map HTML elements to markdown elements (P, strong, code blocks, blockquotes, lists, tables).
- Keydown listener on `document`: Intercept Enter keypresses on target editors (ignoring Shift/IME/programmatic values), prevent default behaviors, broadcast text, and submit.
- Click/Mousedown listener: Detect clicks on send buttons, extract content, and broadcast.

### 7. content/gemini.js, claude.js, chatgpt.js
- Invoke `MultiPrompt.init({...})` passing site selectors and callbacks.
- Selectors:
  - Gemini: input selector `rich-textarea div[contenteditable="true"], .ProseMirror`, send selector `button[aria-label*="Send message"], .send-button`. New chat clicks the "New Chat" link/button or redirects to homepage.
  - Claude: input selector `.ProseMirror, div[contenteditable="true"]`, send selector `button[aria-label*="Send"], button[data-testid="send-button"]`. New chat clicks `/new` link or redirects.
  - ChatGPT: input selector `#prompt-textarea, div[contenteditable="true"]`, send selector `button[data-testid="send-button"]`. New chat clicks new-chat buttons or redirects.
- Extraction rules: Iterate user prompts and assistant message containers, strip screen-reader prefixes (like "You said"), parse formatting, and compile history turns.

### 8. export.html & export.js
- Standalone HTML page with styling for printing/saving to PDF.
- Theme support matching current user preference.
- Retrieve exported history from storage, group turns chronologically, and render user prompt blocks stacked with response cards colored by brand.
- Render markdown elements into standard HTML using a simple custom markdown regex parser.
- Auto-trigger print view (`window.print()`) after loading.

Provide code implementations that are robust, error-tolerant, and handle corner cases gracefully. Avoid using placeholders or simplified loops.
```
