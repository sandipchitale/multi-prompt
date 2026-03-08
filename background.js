const AI_URLS = {
  gemini: "https://gemini.google.com/app",
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/"
};

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Map of tabId -> prompt string to handle lazy injections
const activePromptTabs = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'launch_tabs') {
    launchTabsIfMissing(request.models);
    sendResponse({ status: 'launched' });
  } else if (request.action === 'send_prompt') {
    sendPromptToTabs(request.models, request.prompt);
    sendResponse({ status: 'sent' });
  } else if (request.action === 'new_chat') {
    sendActionToTabs(request.models, 'new_chat');
    sendResponse({ status: 'new_chat_sent' });
  } else if (request.action === 'swap_tabs') {
    swapTabs(request.model1, request.model2);
    sendResponse({ status: 'swapping' });
  }
});

async function launchTabsIfMissing(models) {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const allTabs = await chrome.tabs.query({ windowId: currentWindow.id });

    // For each chosen model, check if a tab already exists
    let activeTabIdx = -1;
    
    for (const model of models) {
      const urlBase = AI_URLS[model].split('/')[2]; // e.g., gemini.google.com
      const existingTab = allTabs.find(t => t.url && t.url.includes(urlBase));

      if (!existingTab) {
        // Find the index of the active tab to place new tabs right next to it
        if (activeTabIdx === -1) {
            const activeMatch = allTabs.find(t => t.active);
            activeTabIdx = activeMatch ? activeMatch.index : allTabs.length - 1;
        }
        
        await chrome.tabs.create({
          url: AI_URLS[model],
          index: activeTabIdx + 1,
          active: false
        });
        activeTabIdx++; // Increment so the next one goes next to this one
      }
    }
  } catch (err) {
    console.error("Failed to launch AI tabs:", err);
  }
}

async function sendActionToTabs(models, actionType) {
    try {
        const allTabs = await chrome.tabs.query({});

        for (const model of models) {
            const urlBase = AI_URLS[model].split('/')[2]; 
            const existingTab = allTabs.find(t => t.url && t.url.includes(urlBase));

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

async function sendPromptToTabs(models, prompt) {
    try {
        const currentWindow = await chrome.windows.getCurrent();
        const allTabs = await chrome.tabs.query({});
        
        // Ensure new tabs are placed sensibly if we have to open them
        const tabsInCurrentWindow = allTabs.filter(t => t.windowId === currentWindow.id);
        const activeMatch = tabsInCurrentWindow.find(t => t.active);
        let placementIndex = activeMatch ? activeMatch.index + 1 : tabsInCurrentWindow.length;

        for (const model of models) {
            const urlBase = AI_URLS[model].split('/')[2]; 
            const existingTab = allTabs.find(t => t.url && t.url.includes(urlBase));

            if (existingTab) {
                if (existingTab.status === 'loading') {
                    activePromptTabs.set(existingTab.id, prompt);
                } else {
                    attemptInjection(existingTab.id, prompt, 0);
                }
            } else {
                // Tab doesn't exist anywhere! Let's launch it.
                console.log(`Tab for ${model} missing. Opening on demand...`);
                const newTab = await chrome.tabs.create({
                    url: AI_URLS[model],
                    index: placementIndex,
                    active: false
                });
                placementIndex++;
                
                // Set the prompt in the queue so it injects when it finishes loading
                activePromptTabs.set(newTab.id, prompt);
            }
        }
    } catch (err) {
        console.error("Failed to send prompt:", err);
    }
}

// Track when queued tabs finish loading to inject prompt
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && activePromptTabs.has(tabId)) {
    const prompt = activePromptTabs.get(tabId);
    activePromptTabs.delete(tabId);
    attemptInjection(tabId, prompt, 0);
  }
});

function attemptInjection(tabId, prompt, attempt) {
  if (attempt > 15) {
     console.log("Max injection attempts reached for tab " + tabId);
     return;
  }
  
  chrome.tabs.sendMessage(tabId, {
    action: 'inject_prompt',
    prompt: prompt
  }, (response) => {
     if (chrome.runtime.lastError) {
        setTimeout(() => attemptInjection(tabId, prompt, attempt + 1), 1000);
     } else {
        console.log("Successfully delivered prompt to tab " + tabId);
     }
  });
}

// Swap specific AI tabs by exchanging their URLs
async function swapTabs(model1, model2) {
  try {
    const allTabs = await chrome.tabs.query({});
    
    const urlBase1 = AI_URLS[model1].split('/')[2];
    const urlBase2 = AI_URLS[model2].split('/')[2];

    const tab1 = allTabs.find(t => t.url && t.url.includes(urlBase1));
    const tab2 = allTabs.find(t => t.url && t.url.includes(urlBase2));

    if (tab1 && tab2) {
      const url1 = tab1.url;
      const url2 = tab2.url;

      await chrome.tabs.update(tab1.id, { url: url2 });
      await chrome.tabs.update(tab2.id, { url: url1 });
    } else {
      console.warn(`Could not find both tabs to swap: ${model1}, ${model2}`);
    }
  } catch (err) {
    console.error("Failed to swap tabs:", err);
  }
}
