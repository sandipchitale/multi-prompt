# Multi-Prompt Chrome (and Safari) Extension 🚀

The Multi-Prompt extension is a productivity tool that tiles Gemini, Claude, and ChatGPT side-by-side on your screen and synchronizes your prompts across all of them.

Instead of typing prompts inside an extension panel, you type and submit a prompt in **any** of the tiled chatbot windows, and the extension automatically broadcasts and submits that same prompt in all other active chatbot windows.

## Features ✨

- **Multi-Model Support:** Select any combination of Gemini, Claude, and ChatGPT (from 1 to all 3).
- **Prompt Broadcasting:** Type your prompt natively in Claude, Gemini, or ChatGPT and it is replicated and submitted in the other tiled windows.
- **Smart "Tile Windows":** Click "Tile Windows" in the popup to position and size the selected chatbots side-by-side across your screen. Existing chatbot tabs are reused (and pulled into their own window if needed) rather than duplicated.
- **Visual Tiling Order & Swapping:** Arrange the left-to-right window order directly from the popup. Swapping physically slides the windows on screen without page reloads or losing your chat state.
- **Master "New Chat" Control:** Start fresh threads on all active models at once with a single click.
- **Bookmark Session:** Bookmark your active chatbot session tabs into a timestamped subfolder under a `"Multi-prompt"` parent folder inside Chrome Bookmarks. Reloading these bookmarked conversations and clicking "Tile Windows" will tile them back perfectly.
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
