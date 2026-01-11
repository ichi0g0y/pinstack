import { getSyncState, updateLocalState, wasRecentLocalWrite, SYNC_KEY } from "./storage.js";
import type { PinnedItem } from "./types.js";

type TabInfo = { id?: number; url?: string; pendingUrl?: string };
type TabsQuery = { windowId?: number; currentWindow?: boolean; pinned?: boolean };
type TabCreate = { windowId?: number; url?: string; pinned?: boolean; index?: number };
type WindowInfo = { id?: number; type?: string };

function queryTabs(queryInfo: TabsQuery): Promise<TabInfo[]> {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs: TabInfo[]) => resolve(tabs));
  });
}

function createTab(createProperties: TabCreate): Promise<TabInfo> {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab: TabInfo) => resolve(tab));
  });
}

function removeTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function isBlankNewTab(tab: TabInfo | undefined): boolean {
  if (!tab) return false;
  const url = tab.pendingUrl ?? tab.url ?? "";
  return url === "about:blank" || url.startsWith("chrome://newtab");
}

async function createPinnedTabs(windowId: number, items: PinnedItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    await createTab({ windowId, url: item.url, pinned: true, index: i });
  }
}

async function maybeRestoreDefaultGroup(windowId: number | undefined): Promise<void> {
  if (!windowId) return;
  const tabs = await queryTabs({ windowId });
  if (tabs.length !== 1 || !isBlankNewTab(tabs[0])) return;

  const state = await getSyncState();
  const group = state.groups.find((candidate) => candidate.id === state.defaultGroupId);
  if (!group || group.items.length === 0) return;

  await createPinnedTabs(windowId, group.items);

  const blankTab = tabs[0];
  if (blankTab?.id !== undefined) {
    await removeTab(blankTab.id);
  }
}

chrome.windows.onCreated.addListener((window: WindowInfo) => {
  if (window.type && window.type !== "normal") return;
  void maybeRestoreDefaultGroup(window.id);
});

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

chrome.storage.onChanged.addListener((changes: StorageChanges, areaName: string) => {
  if (areaName !== "sync" || !changes[SYNC_KEY]) return;
  void (async () => {
    const recentLocalWrite = await wasRecentLocalWrite();
    if (recentLocalWrite) return;

    await updateLocalState({ hasRemoteUpdate: true });
    await chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
    await chrome.action.setBadgeText({ text: "!" });
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
});
