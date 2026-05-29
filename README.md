# Multi-Prompt Chrome Extension 🚀

The Multi-Prompt Chrome Extension is a powerful productivity tool that allows you to tile multiple AI chatbots—Gemini, Claude, and ChatGPT—side-by-side on your screen and synchronize your prompts across all of them in real-time.

Instead of typing prompts inside an extension panel, this extension allows you to type and submit a prompt in **any** of the open chatbot windows, and it will automatically broadcast and submit that same prompt in all other active chatbot windows.

## Features ✨

- **Multi-Model Support:** Select any combination of Gemini, Claude, and ChatGPT (from 1 to all 3).
- **Bidirectional Prompt Broadcasting:** Type your prompt natively in Claude, Gemini, or ChatGPT, and watch it automatically replicate and submit in the other tiled windows.
- **Smart "Tile Windows":** Click "Tile Windows" in the extension popup to automatically position and size your selected chatbots side-by-side across your screen. 
- **Visual Tiling Order & Swapping:** Arrange the layout order of your windows (Left-to-Right) directly from the popup. Swapping windows physically slides them on screen without page reloads or losing your active chat states.
- **Master "New Chat" Control:** Instantly clear the conversational context and start fresh threads on all active models simultaneously with one click.
- **Selective Syncing:** Only prompts typed inside the extension-managed tiled windows are synchronized. Chatbots opened by you in normal tabs are ignored.

## How It Works ⚙️

Because modern AI chatbots enforce strict security policies, this extension uses a combination of a **Background Service Worker** and **Chrome Content Scripts**:

1. The **Extension Popup** acts as the configuration dashboard, allowing you to select active models and tile them.
2. **Content Scripts** (`content/*.js`) are injected onto the chatbot pages to listen for user submissions (either hitting Enter or clicking Send).
3. When a submission is detected in an extension-managed window, the content script forwards the prompt text to the **Background Service Worker** (`background.js`).
4. The background worker verifies that the source tab belongs to a tiled window, and forwards the prompt to all other active chatbot content scripts.
5. Target content scripts inject the text natively and trigger the submit handlers of Claude, Gemini, or ChatGPT.

## Installation from Source 💻

Since this is an unpacked developer extension, you can install it natively in your browser in just a few seconds:

1. **Download/Clone the Source:** Make sure you have this `multi-prompt` folder saved somewhere memorable on your computer.
2. **Open Chrome Extensions:** Open Google Chrome and type `chrome://extensions/` into your address bar, then hit Enter.
3. **Enable Developer Mode:** In the top right corner of the Extensions page, toggle the **Developer mode** switch to **ON**.
4. **Load Unpacked:** Click the **Load unpacked** button that appears in the top left.
5. **Select the Folder:** Browse to the `multi-prompt` folder (the directory containing the `manifest.json` file) and select it.
6. **Pin It!:** Click the puzzle piece icon next to your Chrome address bar, find "Multi-Prompt", and click the pushpin icon to stick it to your taskbar for easy access.

Enjoy supercharged multi-AI prompting!
