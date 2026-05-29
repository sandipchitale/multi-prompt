const AI_URLS = {
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/"
};

// Match a tab to a model by comparing hostnames, so a stray URL that merely
// contains the host string somewhere (e.g. in a query parameter) is not
// mistaken for the chatbot tab.
function tabMatchesModel(tab, model) {
  if (!tab.url) return false;
  try {
    return new URL(tab.url).hostname === new URL(AI_URLS[model]).hostname;
  } catch (e) {
    return false;
  }
}

// Helper functions for session storage of managed windows
async function getManagedWindowIds() {
  const result = await chrome.storage.session.get(['managedWindowIds']);
  return new Set(result.managedWindowIds || []);
}

async function addManagedWindowId(windowId) {
  const ids = await getManagedWindowIds();
  ids.add(windowId);
  await chrome.storage.session.set({ managedWindowIds: Array.from(ids) });
}

async function removeManagedWindowId(windowId) {
  const ids = await getManagedWindowIds();
  ids.delete(windowId);
  await chrome.storage.session.set({ managedWindowIds: Array.from(ids) });
}

async function hasManagedWindowId(windowId) {
  const ids = await getManagedWindowIds();
  return ids.has(windowId);
}

// Clean up closed windows
chrome.windows.onRemoved.addListener(async (windowId) => {
  await removeManagedWindowId(windowId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'launch_tabs') {
    tileWindows(request.models, request.screenInfo);
    sendResponse({ status: 'launched' });
  } else if (request.action === 'new_chat') {
    sendActionToTabs(request.models, 'new_chat');
    sendResponse({ status: 'new_chat_sent' });
  } else if (request.action === 'swap_tabs') {
    swapTabs(request.model1, request.model2);
    sendResponse({ status: 'swapping' });
  } else if (request.action === 'broadcast_prompt') {
    handleBroadcast(request.prompt, request.source, sender);
    sendResponse({ status: 'broadcasted' });
  }
});

async function tileWindows(models, screenInfo) {
  try {
    const { availLeft, availTop, availWidth, availHeight } = screenInfo;
    const N = models.length;
    if (N === 0) return;

    const baseWidth = Math.floor(availWidth / N);
    const height = availHeight;

    const allTabs = await chrome.tabs.query({});

    for (let i = 0; i < N; i++) {
      const model = models[i];
      const existingTab = allTabs.find(t => tabMatchesModel(t, model));

      const left = availLeft + (i * baseWidth);
      const top = availTop;
      // Give the last window any leftover pixels so the row spans the full
      // width instead of leaving a gap when availWidth isn't divisible by N.
      const width = (i === N - 1) ? (availWidth - i * baseWidth) : baseWidth;

      if (existingTab) {
        // Check how many tabs are in the existing window
        const tabsInWindow = await chrome.tabs.query({ windowId: existingTab.windowId });
        if (tabsInWindow.length === 1) {
          // Window has only 1 tab. Just move and resize it.
          await chrome.windows.update(existingTab.windowId, {
            state: "normal",
            left: left,
            top: top,
            width: width,
            height: height,
            focused: true
          });
          await addManagedWindowId(existingTab.windowId);
        } else {
          // Tab is in a window with other tabs. Extract it to its own window at the tiled coordinates.
          const newWin = await chrome.windows.create({
            tabId: existingTab.id,
            left: left,
            top: top,
            width: width,
            height: height,
            focused: true,
            type: "normal"
          });
          await addManagedWindowId(newWin.id);
        }
      } else {
        // Tab does not exist at all. Create a new window for it.
        const newWin = await chrome.windows.create({
          url: AI_URLS[model],
          left: left,
          top: top,
          width: width,
          height: height,
          focused: true,
          type: "normal"
        });
        await addManagedWindowId(newWin.id);
      }
    }
  } catch (err) {
    console.error("Failed to tile windows:", err);
  }
}

async function sendActionToTabs(models, actionType) {
    try {
        const allTabs = await chrome.tabs.query({});

        for (const model of models) {
            const existingTab = allTabs.find(t => tabMatchesModel(t, model));

            if (existingTab) {
                chrome.tabs.sendMessage(existingTab.id, {
                    action: actionType
                }, (response) => {
                     if (chrome.runtime.lastError) {
                         console.warn(`Could not send ${actionType} to ${model}`);
                     } else {
                         console.log(`Successfully sent ${actionType} to ${model}`);
                     }
                });
            } else {
                console.warn(`Attempted to send ${actionType} to ${model} but no tab was found anywhere.`);
            }
        }
    } catch (err) {
        console.error(`Failed to send ${actionType}:`, err);
    }
}

// Swap specific AI tabs by exchanging their window positions
async function swapTabs(model1, model2) {
  try {
    const allTabs = await chrome.tabs.query({});

    const tab1 = allTabs.find(t => tabMatchesModel(t, model1));
    const tab2 = allTabs.find(t => tabMatchesModel(t, model2));

    if (tab1 && tab2) {
      if (tab1.windowId !== tab2.windowId) {
        const win1 = await chrome.windows.get(tab1.windowId);
        const win2 = await chrome.windows.get(tab2.windowId);

        // Swap position and size
        await chrome.windows.update(win1.id, {
          state: "normal",
          left: win2.left,
          top: win2.top,
          width: win2.width,
          height: win2.height
        });

        await chrome.windows.update(win2.id, {
          state: "normal",
          left: win1.left,
          top: win1.top,
          width: win1.width,
          height: win1.height
        });
      } else {
        // Fallback: if they are in the same window, just swap their URLs
        const url1 = tab1.url;
        const url2 = tab2.url;

        await chrome.tabs.update(tab1.id, { url: url2 });
        await chrome.tabs.update(tab2.id, { url: url1 });
      }
    } else {
      console.warn(`Could not find both tabs to swap: ${model1}, ${model2}`);
    }
  } catch (err) {
    console.error("Failed to swap tabs/windows:", err);
  }
}

async function handleBroadcast(prompt, source, sender) {
  try {
    const senderWindowId = sender.tab ? sender.tab.windowId : 'undefined';
    const managedIds = await getManagedWindowIds();
    
    // Only broadcast if the source window is one of our tiled windows
    if (!sender.tab || !managedIds.has(sender.tab.windowId)) {
      console.warn(`Blocked broadcast: source window ${senderWindowId} is not extension-managed.`);
      return;
    }

    // Load current selectedModels to know who to broadcast to
    chrome.storage.local.get(['selectedModels'], async (result) => {
      const selected = result.selectedModels || ['gemini', 'claude', 'chatgpt'];
      
      // Filter out the source model
      const targetModels = selected.filter(m => m !== source);
      
      const allTabs = await chrome.tabs.query({});
      
      for (const model of targetModels) {
        const tab = allTabs.find(t => tabMatchesModel(t, model));

        if (tab) {
          const isManaged = managedIds.has(tab.windowId);
          
          // Only inject if the target tab is in our extensionWindowIds set
          if (isManaged) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'inject_prompt',
              prompt: prompt
            }, (response) => {
               if (chrome.runtime.lastError) {
                  console.warn(`Could not deliver broadcast to ${model}:`, chrome.runtime.lastError);
               }
            });
          }
        }
      }
    });
  } catch (err) {
    console.error("Broadcast failed:", err);
  }
}
