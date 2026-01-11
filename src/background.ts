import {
  ensureDefaultGroup,
  generateId,
  getLocalState,
  getSyncState,
  markLocalWrite,
  setActiveGroupId,
  setSyncState,
  updateLocalState,
  wasRecentLocalWrite,
  SYNC_KEY,
} from "./storage.js";
import type { PinnedGroup, PinnedItem, SyncStateV1 } from "./types.js";

type TabInfo = {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  pinned?: boolean;
  windowId?: number;
  index?: number;
};
type TabChangeInfo = { pinned?: boolean };
type TabsQuery = { windowId?: number; currentWindow?: boolean; pinned?: boolean };
type TabCreate = { windowId?: number; url?: string; pinned?: boolean; index?: number };
type TabUpdate = { pinned?: boolean };
type WindowInfo = { id?: number; type?: string };
type TabRemoveInfo = { windowId: number; isWindowClosing?: boolean };
type TabMoveInfo = { windowId: number; fromIndex: number; toIndex: number };
type TabDetachInfo = { oldWindowId: number; oldPosition: number };
type TabAttachInfo = { newWindowId: number; newPosition: number };

const pinnedTabIds = new Set<number>();
let isApplyingGroup = false;

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

function updateTab(tabId: number, updateProperties: TabUpdate): Promise<TabInfo> {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProperties, (tab: TabInfo) => resolve(tab));
  });
}

function moveTab(tabId: number, index: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.move(tabId, { index }, () => resolve());
  });
}

function removeTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function getAllWindows(): Promise<WindowInfo[]> {
  return new Promise((resolve) => {
    chrome.windows.getAll({ windowTypes: ["normal"] }, (windows: WindowInfo[]) => resolve(windows));
  });
}

function getLastFocusedWindowId(): Promise<number | undefined> {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({}, (window: WindowInfo) => resolve(window?.id));
  });
}

function normalizeUrl(tab: TabInfo | undefined): string | undefined {
  if (!tab) return undefined;
  const url = tab.pendingUrl ?? tab.url ?? "";
  if (!url || url === "about:blank" || url.startsWith("chrome://newtab")) return undefined;
  return url;
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

function tabToItem(tab: TabInfo): PinnedItem | null {
  const url = normalizeUrl(tab);
  if (!url) return null;
  const item: PinnedItem = { url };
  if (tab.title) item.title = tab.title;
  return item;
}

function dedupeItems(items: PinnedItem[]): PinnedItem[] {
  const seen = new Set<string>();
  const result: PinnedItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}

async function getPinnedItems(queryInfo: TabsQuery): Promise<PinnedItem[]> {
  const tabs = await queryTabs(queryInfo);
  const items = tabs.map(tabToItem).filter((item): item is PinnedItem => Boolean(item));
  return dedupeItems(items);
}

async function getPinnedItemsForLastFocusedWindow(): Promise<PinnedItem[]> {
  const windowId = await getLastFocusedWindowId();
  if (!windowId) return [];
  return getPinnedItems({ windowId, pinned: true });
}

async function seedPinnedTabIds(): Promise<void> {
  pinnedTabIds.clear();
  const tabs = await queryTabs({ pinned: true });
  for (const tab of tabs) {
    if (typeof tab.id === "number") {
      pinnedTabIds.add(tab.id);
    }
  }
}

async function resolveSyncGroupId(state: SyncStateV1): Promise<string | undefined> {
  const localState = await getLocalState();
  if (localState.activeGroupId && state.groups.some((group) => group.id === localState.activeGroupId)) {
    return localState.activeGroupId;
  }
  return state.defaultGroupId;
}

async function updateGroupItems(groupId: string, items: PinnedItem[]): Promise<boolean> {
  const state = await ensureDefaultGroup();
  const target = state.groups.find((group) => group.id === groupId);
  if (!target) return false;

  const same =
    target.items.length === items.length &&
    target.items.every((item, index) => {
      const candidate = items[index];
      return item.url === candidate?.url && item.title === candidate?.title;
    });

  if (same) return false;

  const now = Date.now();
  const nextGroups = state.groups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          items,
          updatedAt: now,
        }
      : group
  );

  const nextState: SyncStateV1 = {
    ...state,
    groups: nextGroups,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  return true;
}

async function applyGroupToWindow(windowId: number, items: PinnedItem[]): Promise<void> {
  const tabs = await queryTabs({ windowId });
  const pinnedTabs = tabs.filter((tab) => tab.pinned);
  const available = new Map<string, TabInfo[]>();

  for (const tab of pinnedTabs) {
    const url = normalizeUrl(tab);
    if (!url) continue;
    const list = available.get(url) ?? [];
    list.push(tab);
    available.set(url, list);
  }

  const keepTabIds = new Set<number>();
  const orderedTabIds: number[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const url = items[i].url;
    const list = available.get(url);
    const existing = list?.shift();

    if (existing?.id !== undefined) {
      keepTabIds.add(existing.id);
      orderedTabIds.push(existing.id);
      continue;
    }

    const created = await createTab({ windowId, url, pinned: true, index: i });
    if (typeof created.id === "number") {
      pinnedTabIds.add(created.id);
      keepTabIds.add(created.id);
      orderedTabIds.push(created.id);
    }
  }

  for (const tab of pinnedTabs) {
    if (tab.id === undefined) continue;
    if (keepTabIds.has(tab.id)) continue;
    await updateTab(tab.id, { pinned: false });
    pinnedTabIds.delete(tab.id);
  }

  for (let i = 0; i < orderedTabIds.length; i += 1) {
    await moveTab(orderedTabIds[i], i);
  }
}

async function applyGroupToAllWindows(items: PinnedItem[]): Promise<void> {
  if (isApplyingGroup) return;
  isApplyingGroup = true;
  try {
    const windows = await getAllWindows();
    for (const window of windows) {
      if (typeof window.id !== "number") continue;
      await applyGroupToWindow(window.id, items);
    }
  } finally {
    isApplyingGroup = false;
  }
}

async function syncPinnedTabsFromWindow(
  windowId: number | undefined,
  options: { allowEmpty?: boolean } = {}
): Promise<void> {
  if (!windowId) return;
  const state = await ensureDefaultGroup();
  const groupId = await resolveSyncGroupId(state);
  if (!groupId) return;

  const items = await getPinnedItems({ windowId, pinned: true });
  if (items.length === 0 && !options.allowEmpty) return;
  const changed = await updateGroupItems(groupId, items);
  if (changed) {
    await applyGroupToAllWindows(items);
  }
}

async function initializeSyncState(): Promise<void> {
  const state = await getSyncState();
  if (state.groups.length === 0) {
    const items = await getPinnedItems({ pinned: true });
    if (items.length > 0) {
      const now = Date.now();
      const seededGroup: PinnedGroup = {
        id: generateId(),
        name: "",
        items,
        createdAt: now,
        updatedAt: now,
      };
      const nextState: SyncStateV1 = {
        version: 1,
        groups: [seededGroup],
        defaultGroupId: seededGroup.id,
      };
      await markLocalWrite();
      await setSyncState(nextState);
      await setActiveGroupId(seededGroup.id);
      await applyGroupToAllWindows(items);
      await seedPinnedTabIds();
      return;
    }
  }

  await ensureDefaultGroup();
  await seedPinnedTabIds();
}

async function seedGroupFromExistingPins(): Promise<void> {
  const state = await ensureDefaultGroup();
  const groupId = await resolveSyncGroupId(state);
  if (!groupId) return;

  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group || group.items.length > 0) return;

  let items = await getPinnedItemsForLastFocusedWindow();
  if (items.length === 0) {
    items = await getPinnedItems({ pinned: true });
  }
  if (items.length === 0) return;

  const changed = await updateGroupItems(groupId, items);
  if (changed) {
    await applyGroupToAllWindows(items);
  }
}

async function maybeRestoreDefaultGroup(windowId: number | undefined): Promise<void> {
  if (!windowId) return;
  const [tabs, pinnedTabs] = await Promise.all([
    queryTabs({ windowId }),
    queryTabs({ windowId, pinned: true }),
  ]);

  if (pinnedTabs.length > 0) return;

  const state = await ensureDefaultGroup();
  const groupId = await resolveSyncGroupId(state);
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group || group.items.length === 0) return;

  await createPinnedTabs(windowId, group.items);

  const blankTab = tabs.find((tab) => isBlankNewTab(tab));
  if (blankTab?.id !== undefined) {
    await removeTab(blankTab.id);
  }
}

async function maybeRestoreDefaultGroupInAllWindows(): Promise<void> {
  const tabs = await queryTabs({});
  const windowIds = new Set<number>();
  for (const tab of tabs) {
    if (typeof tab.windowId === "number") {
      windowIds.add(tab.windowId);
    }
  }

  for (const windowId of windowIds) {
    await maybeRestoreDefaultGroup(windowId);
  }
}

chrome.windows.onCreated.addListener((window: WindowInfo) => {
  if (window.type && window.type !== "normal") return;
  void maybeRestoreDefaultGroup(window.id);
});

chrome.tabs.onCreated.addListener((tab: TabInfo) => {
  if (isApplyingGroup) return;
  if (!tab.pinned) return;
  if (typeof tab.id === "number") {
    pinnedTabIds.add(tab.id);
  }
  void syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: TabChangeInfo, tab: TabInfo) => {
  if (isApplyingGroup) return;
  if (typeof changeInfo.pinned === "undefined") return;
  if (changeInfo.pinned) {
    pinnedTabIds.add(tabId);
  } else {
    pinnedTabIds.delete(tabId);
  }
  void syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
});

chrome.tabs.onRemoved.addListener((tabId: number, removeInfo: TabRemoveInfo) => {
  if (isApplyingGroup) return;
  if (!pinnedTabIds.has(tabId)) return;
  pinnedTabIds.delete(tabId);
  void syncPinnedTabsFromWindow(removeInfo.windowId, { allowEmpty: true });
});

chrome.tabs.onMoved.addListener((tabId: number, moveInfo: TabMoveInfo) => {
  if (isApplyingGroup) return;
  if (!pinnedTabIds.has(tabId)) return;
  void syncPinnedTabsFromWindow(moveInfo.windowId);
});

chrome.tabs.onDetached.addListener((tabId: number, detachInfo: TabDetachInfo) => {
  if (isApplyingGroup) return;
  if (!pinnedTabIds.has(tabId)) return;
  void syncPinnedTabsFromWindow(detachInfo.oldWindowId);
});

chrome.tabs.onAttached.addListener((tabId: number, attachInfo: TabAttachInfo) => {
  if (isApplyingGroup) return;
  if (!pinnedTabIds.has(tabId)) return;
  void syncPinnedTabsFromWindow(attachInfo.newWindowId);
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

    const state = await ensureDefaultGroup();
    const groupId = await resolveSyncGroupId(state);
    const group = state.groups.find((candidate) => candidate.id === groupId);
    if (group) {
      await applyGroupToAllWindows(group.items);
    }
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
  void (async () => {
    await initializeSyncState();
    await seedGroupFromExistingPins();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await initializeSyncState();
    await seedGroupFromExistingPins();
    await maybeRestoreDefaultGroupInAllWindows();
  })();
});

void (async () => {
  await initializeSyncState();
  await seedGroupFromExistingPins();
})();
