import { getSyncState, updateLocalState, wasRecentLocalWrite, SYNC_KEY } from "./storage.js";
function queryTabs(queryInfo) {
    return new Promise((resolve) => {
        chrome.tabs.query(queryInfo, (tabs) => resolve(tabs));
    });
}
function createTab(createProperties) {
    return new Promise((resolve) => {
        chrome.tabs.create(createProperties, (tab) => resolve(tab));
    });
}
function removeTab(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.remove(tabId, () => resolve());
    });
}
function isBlankNewTab(tab) {
    if (!tab)
        return false;
    const url = tab.pendingUrl ?? tab.url ?? "";
    return url === "about:blank" || url.startsWith("chrome://newtab");
}
async function createPinnedTabs(windowId, items) {
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        await createTab({ windowId, url: item.url, pinned: true, index: i });
    }
}
async function maybeRestoreDefaultGroup(windowId) {
    if (!windowId)
        return;
    const tabs = await queryTabs({ windowId });
    if (tabs.length !== 1 || !isBlankNewTab(tabs[0]))
        return;
    const state = await getSyncState();
    const group = state.groups.find((candidate) => candidate.id === state.defaultGroupId);
    if (!group || group.items.length === 0)
        return;
    await createPinnedTabs(windowId, group.items);
    const blankTab = tabs[0];
    if (blankTab?.id !== undefined) {
        await removeTab(blankTab.id);
    }
}
chrome.windows.onCreated.addListener((window) => {
    if (window.type && window.type !== "normal")
        return;
    void maybeRestoreDefaultGroup(window.id);
});
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[SYNC_KEY])
        return;
    void (async () => {
        const recentLocalWrite = await wasRecentLocalWrite();
        if (recentLocalWrite)
            return;
        await updateLocalState({ hasRemoteUpdate: true });
        await chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
        await chrome.action.setBadgeText({ text: "!" });
    })();
});
chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
});
