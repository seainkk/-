importScripts('shared.js');

chrome.action.onClicked.addListener(async function (tab) {
  if (typeof tab.id === 'number') {
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: RegistryTasks.messageType
      });
      if (result && result.handled === true) return;
    } catch (_) {
      // An unrelated tab or a tab opened before installation has no receiver.
    }
  }
  await chrome.tabs.create({ url: RegistryTasks.registryUrl });
});
