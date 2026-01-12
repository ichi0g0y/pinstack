import {
  ensureDefaultGroup,
  generateId,
  getLocalState,
  getPreferences,
  getSyncState,
  markLocalWrite,
  setActiveGroupId,
  setSyncState,
  updateLocalState,
  updatePreferences,
  wasRecentLocalWrite,
  PREFS_KEY,
  SYNC_KEY,
} from "./storage.js";
import type { PinnedGroup, PinnedItem, SyncStateV1 } from "./types.js";

type TabInfo = {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  windowId?: number;
  index?: number;
};
type TabChangeInfo = { pinned?: boolean };
type TabsQuery = { windowId?: number; currentWindow?: boolean; pinned?: boolean; active?: boolean };
type TabCreate = { windowId?: number; url?: string; pinned?: boolean; index?: number; active?: boolean };
type TabUpdate = { pinned?: boolean; url?: string; active?: boolean };
type WindowInfo = { id?: number; type?: string };
type TabRemoveInfo = { windowId: number; isWindowClosing?: boolean };
type TabMoveInfo = { windowId: number; fromIndex: number; toIndex: number };
type TabDetachInfo = { oldWindowId: number; oldPosition: number };
type TabAttachInfo = { newWindowId: number; newPosition: number };
type TabActivatedInfo = { tabId: number; windowId: number };

const pinnedTabIds = new Set<number>();
const pinnedTabCache = new Map<number, TabInfo>();
const intentionalRemovals = new Set<number>();
const skipNextActivation = new Set<number>();
let isApplyingGroup = false;
const pendingWindowSync = new Set<number>();
const pendingWindowRerun = new Set<number>();
const windowRestoreLocks = new Set<number>();
const windowStateTimers = new Map<number, number>();
const SUSPENDED_PAGE = chrome.runtime.getURL("suspended.html");
let closePinnedToSuspend = false;

function queryTabs(queryInfo: TabsQuery): Promise<TabInfo[]> {
  return new Promise((resolve) => {
    chrome.tabs.query(queryInfo, (tabs: TabInfo[]) => resolve(tabs));
  });
}

function createTab(createProperties: TabCreate): Promise<TabInfo | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.create(createProperties, (tab: TabInfo) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(tab);
    });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function createTabWithRetry(
  createProperties: TabCreate,
  retries = 8,
  delayMs = 120
): Promise<TabInfo | undefined> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const created = await createTab(createProperties);
    if (created) return created;
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  return undefined;
}

function removeTab(tabId: number): Promise<void> {
  intentionalRemovals.add(tabId);
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
  const suspended = parseSuspendedUrl(url);
  if (suspended?.targetUrl) return suspended.targetUrl;
  return url;
}

function isBlankNewTab(tab: TabInfo | undefined): boolean {
  if (!tab) return false;
  const url = tab.pendingUrl ?? tab.url ?? "";
  return url === "about:blank" || url.startsWith("chrome://newtab");
}

function parseSuspendedUrl(rawUrl: string): { targetUrl?: string; title?: string; faviconUrl?: string } | null {
  if (!rawUrl.startsWith(SUSPENDED_PAGE)) return null;
  try {
    const url = new URL(rawUrl);
    const targetUrl = url.searchParams.get("target") ?? undefined;
    const title = url.searchParams.get("title") ?? undefined;
    const faviconUrl = url.searchParams.get("favicon") ?? undefined;
    return { targetUrl, title, faviconUrl };
  } catch {
    return null;
  }
}

function isHttpUrl(value: string | undefined): boolean {
  return Boolean(value && /^https?:\/\//.test(value));
}

function buildFaviconFallback(targetUrl: string): string | undefined {
  if (!isHttpUrl(targetUrl)) return undefined;
  const url = new URL("https://www.google.com/s2/favicons");
  url.searchParams.set("sz", "64");
  url.searchParams.set("domain_url", targetUrl);
  return url.toString();
}

function normalizeFaviconUrl(input: string | undefined, targetUrl: string): string | undefined {
  if (input && (input.startsWith("data:") || input.startsWith("http://") || input.startsWith("https://"))) {
    return input;
  }
  return buildFaviconFallback(targetUrl);
}

function buildSuspendedUrl(item: PinnedItem): string {
  const url = new URL(SUSPENDED_PAGE);
  url.searchParams.set("target", item.url);
  if (item.title) url.searchParams.set("title", item.title);
  const normalizedFavicon = normalizeFaviconUrl(item.faviconUrl, item.url);
  if (normalizedFavicon) url.searchParams.set("favicon", normalizedFavicon);
  return url.toString();
}

function tabToItem(tab: TabInfo): PinnedItem | null {
  const url = normalizeUrl(tab);
  if (!url) return null;
  const suspended = tab.url ? parseSuspendedUrl(tab.url) : null;
  const item: PinnedItem = {
    url,
    title: suspended?.title ?? tab.title,
    faviconUrl: normalizeFaviconUrl(suspended?.faviconUrl ?? tab.favIconUrl, url),
  };
  return item;
}

function cachePinnedTab(tab: TabInfo): void {
  if (tab.id === undefined) return;
  if (tab.pinned) {
    pinnedTabCache.set(tab.id, {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned,
      windowId: tab.windowId,
      index: tab.index,
    });
  } else {
    pinnedTabCache.delete(tab.id);
  }
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

function getNextGroupOrder(state: SyncStateV1): number {
  const orders = state.groups
    .map((group) => (typeof group.order === "number" ? group.order : -1))
    .filter((order) => Number.isFinite(order));
  return (orders.length ? Math.max(...orders) : -1) + 1;
}

function areItemsEquivalent(a: PinnedItem[], b: PinnedItem[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map((item) => item.url));
  if (setA.size !== a.length) return false;
  for (const item of b) {
    if (!setA.has(item.url)) return false;
  }
  return true;
}

function findMatchingGroup(groups: PinnedGroup[], items: PinnedItem[]): PinnedGroup | undefined {
  return groups.find((group) => areItemsEquivalent(group.items, items));
}

async function getPinnedItems(queryInfo: TabsQuery): Promise<PinnedItem[]> {
  const tabs = await queryTabs(queryInfo);
  const orderedTabs = [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const items = orderedTabs.map(tabToItem).filter((item): item is PinnedItem => Boolean(item));
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

async function updateGroupItems(
  groupId: string,
  items: PinnedItem[]
): Promise<{ changed: boolean; previousItems: PinnedItem[] }> {
  const state = await ensureDefaultGroup();
  const target = state.groups.find((group) => group.id === groupId);
  if (!target) return { changed: false, previousItems: [] };

  const same =
    target.items.length === items.length &&
    target.items.every((item, index) => {
      const candidate = items[index];
      return item.url === candidate?.url && item.title === candidate?.title;
    });

  if (same) return { changed: false, previousItems: target.items };

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
  return { changed: true, previousItems: target.items };
}

async function applyGroupToWindow(
  windowId: number,
  items: PinnedItem[],
  options: { mode?: "exact" | "additive"; removedUrls?: Set<string> } = {}
): Promise<void> {
  const mode = options.mode ?? "exact";
  const tabs = await queryTabs({ windowId });
  const pinnedTabs = tabs.filter((tab) => tab.pinned);
  const unpinnedTabs = tabs.filter((tab) => !tab.pinned);
  const availablePinned = new Map<string, TabInfo[]>();
  const availableUnpinned = new Map<string, TabInfo[]>();

  for (const tab of pinnedTabs) {
    const url = normalizeUrl(tab);
    if (!url) continue;
    const list = availablePinned.get(url) ?? [];
    list.push(tab);
    availablePinned.set(url, list);
  }

  for (const tab of unpinnedTabs) {
    const url = normalizeUrl(tab);
    if (!url) continue;
    const list = availableUnpinned.get(url) ?? [];
    list.push(tab);
    availableUnpinned.set(url, list);
  }

  const keepTabIds = new Set<number>();
  const orderedTabIds: number[] = [];
  const createdUrls = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    const url = items[i].url;
    const pinnedList = availablePinned.get(url);
    const existingPinned = pinnedList?.shift();

    if (existingPinned?.id !== undefined) {
      keepTabIds.add(existingPinned.id);
      orderedTabIds.push(existingPinned.id);
      continue;
    }

    const unpinnedList = availableUnpinned.get(url);
    const existingUnpinned = unpinnedList?.shift();

    if (existingUnpinned?.id !== undefined) {
      await updateTab(existingUnpinned.id, { pinned: true });
      pinnedTabIds.add(existingUnpinned.id);
      keepTabIds.add(existingUnpinned.id);
      orderedTabIds.push(existingUnpinned.id);
      continue;
    }

    if (createdUrls.has(url)) continue;
    createdUrls.add(url);
    const created = await createTabWithRetry({
      windowId,
      url: buildSuspendedUrl(items[i]),
      pinned: true,
      active: false,
    });
    if (typeof created?.id === "number") {
      pinnedTabIds.add(created.id);
      keepTabIds.add(created.id);
      orderedTabIds.push(created.id);
      if (created.pinned) {
        pinnedTabCache.set(created.id, created);
      }
    }
  }

  if (mode === "exact") {
    for (const tab of pinnedTabs) {
      if (tab.id === undefined) continue;
      if (keepTabIds.has(tab.id)) continue;
      await updateTab(tab.id, { pinned: false });
      pinnedTabIds.delete(tab.id);
    }

    for (let i = 0; i < orderedTabIds.length; i += 1) {
      await moveTab(orderedTabIds[i], i);
    }
  } else if (options.removedUrls && options.removedUrls.size > 0) {
    for (const tab of pinnedTabs) {
      const url = normalizeUrl(tab);
      if (!url || !options.removedUrls.has(url)) continue;
      if (tab.id === undefined) continue;
      await removeTab(tab.id);
      pinnedTabIds.delete(tab.id);
    }
  }
}

async function applyGroupToAllWindows(
  items: PinnedItem[],
  options: { sourceWindowId?: number; removedUrls?: Set<string> } = {}
): Promise<void> {
  if (isApplyingGroup) return;
  isApplyingGroup = true;
  try {
    const windows = await getAllWindows();
    for (const window of windows) {
      if (typeof window.id !== "number") continue;
      if (pendingWindowSync.has(window.id)) continue;
      const mode = window.id === options.sourceWindowId ? "exact" : "additive";
      await applyGroupToWindow(window.id, items, { mode, removedUrls: options.removedUrls });
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
  if (pendingWindowSync.has(windowId)) return;
  const state = await ensureDefaultGroup();
  const groupId = await resolveSyncGroupId(state);
  if (!groupId) return;

  const items = await getPinnedItems({ windowId, pinned: true });
  if (items.length === 0 && !options.allowEmpty) return;
  const result = await updateGroupItems(groupId, items);
  if (result.changed) {
    const removedUrls = new Set(
      result.previousItems
        .filter((item) => !items.some((current) => current.url === item.url))
        .map((item) => item.url)
    );
    await applyGroupToAllWindows(items, { sourceWindowId: windowId, removedUrls });
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
        order: 0,
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

async function maybeRestoreDefaultGroup(
  windowId: number | undefined,
  state?: SyncStateV1
): Promise<void> {
  if (!windowId) return;
  const [tabs, pinnedTabs] = await Promise.all([
    queryTabs({ windowId }),
    queryTabs({ windowId, pinned: true }),
  ]);

  if (pinnedTabs.length > 0) return;

  const nextState = state ?? (await ensureDefaultGroup());
  const group = nextState.groups.find((candidate) => candidate.id === nextState.defaultGroupId);
  if (!group || group.items.length === 0) return;

  await applyGroupToWindow(windowId, group.items, { mode: "exact" });
}

async function handleWindowState(windowId: number | undefined): Promise<void> {
  if (!windowId) return;

  await new Promise((resolve) => setTimeout(resolve, 150));
  const items = await getPinnedItems({ windowId, pinned: true });

  if (items.length === 0) {
    const state = await ensureDefaultGroup();
    if (state.defaultGroupId) {
      await setActiveGroupId(state.defaultGroupId);
    }
    await maybeRestoreDefaultGroup(windowId, state);
    return;
  }

  const state = await ensureDefaultGroup();
  const matchingGroup = findMatchingGroup(state.groups, items);

  if (matchingGroup) {
    await setActiveGroupId(matchingGroup.id);
    await updateGroupItems(matchingGroup.id, items);
    return;
  }

  const now = Date.now();
  const newGroup: PinnedGroup = {
    id: generateId(),
    name: "",
    items,
    createdAt: now,
    updatedAt: now,
    order: getNextGroupOrder(state),
  };
  const nextState: SyncStateV1 = {
    ...state,
    groups: [...state.groups, newGroup],
  };
  await markLocalWrite();
  await setSyncState(nextState);
  await setActiveGroupId(newGroup.id);
}

async function scheduleWindowState(windowId: number | undefined): Promise<void> {
  if (!windowId) return;
  if (windowRestoreLocks.has(windowId)) return;
  windowRestoreLocks.add(windowId);
  if (pendingWindowSync.has(windowId)) {
    pendingWindowRerun.add(windowId);
    windowRestoreLocks.delete(windowId);
    return;
  }
  pendingWindowSync.add(windowId);
  try {
    await handleWindowState(windowId);
  } finally {
    pendingWindowSync.delete(windowId);
    windowRestoreLocks.delete(windowId);
    if (pendingWindowRerun.has(windowId)) {
      pendingWindowRerun.delete(windowId);
      await scheduleWindowState(windowId);
    }
  }
}

async function loadPreferences(): Promise<void> {
  const [prefs, localState] = await Promise.all([getPreferences(), getLocalState()]);
  if (!prefs.closePinnedToSuspend && localState.closePinnedToSuspend) {
    const next = await updatePreferences({ closePinnedToSuspend: true });
    closePinnedToSuspend = Boolean(next.closePinnedToSuspend);
    return;
  }
  closePinnedToSuspend = Boolean(prefs.closePinnedToSuspend);
}

function scheduleWindowStateDebounced(windowId: number | undefined, delayMs = 250): void {
  if (!windowId) return;
  const existing = windowStateTimers.get(windowId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    windowStateTimers.delete(windowId);
    void scheduleWindowState(windowId);
  }, delayMs);
  windowStateTimers.set(windowId, timer as unknown as number);
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

async function handleLastFocusedWindow(): Promise<void> {
  const windowId = await getLastFocusedWindowId();
  if (!windowId) return;
  await scheduleWindowState(windowId);
}

chrome.windows.onCreated.addListener((window: WindowInfo) => {
  if (window.type && window.type !== "normal") return;
  if (typeof window.id !== "number") return;
  scheduleWindowStateDebounced(window.id, 250);
});

chrome.tabs.onCreated.addListener((tab: TabInfo) => {
  if (isApplyingGroup) return;
  if (!tab.pinned) return;
  if (typeof tab.id === "number") {
    pinnedTabIds.add(tab.id);
    cachePinnedTab(tab);
  }
  void syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: TabChangeInfo, tab: TabInfo) => {
  if (isApplyingGroup) return;
  if (tab.pinned) {
    cachePinnedTab(tab);
  }
  if (typeof changeInfo.pinned === "undefined") return;
  if (changeInfo.pinned) {
    pinnedTabIds.add(tabId);
    cachePinnedTab(tab);
  } else {
    pinnedTabIds.delete(tabId);
    pinnedTabCache.delete(tabId);
  }
  void syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
});

chrome.tabs.onActivated.addListener((activeInfo: TabActivatedInfo) => {
  void (async () => {
    const tab = await new Promise<TabInfo | undefined>((resolve) => {
      chrome.tabs.get(activeInfo.tabId, (result: TabInfo) => resolve(result));
    });
    if (!tab?.url) return;
    const suspended = parseSuspendedUrl(tab.url);
    if (!suspended?.targetUrl) return;
    if (skipNextActivation.has(activeInfo.tabId)) {
      skipNextActivation.delete(activeInfo.tabId);
      return;
    }
    await updateTab(activeInfo.tabId, { url: suspended.targetUrl });
  })();
});

chrome.commands.onCommand.addListener((command: string) => {
  if (command !== "suspend-pinned-tab") return;
  void (async () => {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || !tab.pinned) return;
    if (tab.url && tab.url.startsWith(SUSPENDED_PAGE)) return;
    const item = tabToItem(tab);
    if (!item) return;
    await updateTab(tab.id, { url: buildSuspendedUrl(item) });
  })();
});

chrome.tabs.onRemoved.addListener((tabId: number, removeInfo: TabRemoveInfo) => {
  if (isApplyingGroup) return;
  void (async () => {
    const wasPinned = pinnedTabIds.has(tabId);
    if (wasPinned) {
      pinnedTabIds.delete(tabId);
    }
    if (removeInfo.isWindowClosing) {
      return;
    }
    if (!wasPinned) return;
    if (intentionalRemovals.has(tabId)) {
      intentionalRemovals.delete(tabId);
      pinnedTabCache.delete(tabId);
      return;
    }
    if (closePinnedToSuspend) {
      const cached = pinnedTabCache.get(tabId);
      pinnedTabCache.delete(tabId);
      if (cached) {
        const item = tabToItem(cached);
        if (item) {
          const windowId = typeof cached.windowId === "number" ? cached.windowId : removeInfo.windowId;
          const index = typeof cached.index === "number" ? cached.index : 0;
          const created = await createTabWithRetry({
            windowId,
            url: buildSuspendedUrl(item),
            pinned: true,
            index,
            active: true,
          });
          if (typeof created?.id === "number") {
            pinnedTabIds.add(created.id);
            if (created.pinned) {
              pinnedTabCache.set(created.id, created);
            }
            skipNextActivation.add(created.id);
          }
          return;
        }
      }
    } else {
      pinnedTabCache.delete(tabId);
    }
    await syncPinnedTabsFromWindow(removeInfo.windowId, { allowEmpty: true });
  })();
});

chrome.tabs.onMoved.addListener((tabId: number, moveInfo: TabMoveInfo) => {
  if (isApplyingGroup) return;
  const cached = pinnedTabCache.get(tabId);
  if (cached) {
    pinnedTabCache.set(tabId, { ...cached, index: moveInfo.toIndex, windowId: moveInfo.windowId });
  }
  if (!pinnedTabIds.has(tabId)) return;
  void syncPinnedTabsFromWindow(moveInfo.windowId);
});

chrome.tabs.onDetached.addListener((tabId: number, detachInfo: TabDetachInfo) => {
  if (isApplyingGroup) return;
  const cached = pinnedTabCache.get(tabId);
  if (cached) {
    pinnedTabCache.set(tabId, { ...cached, windowId: detachInfo.oldWindowId });
  }
  if (!pinnedTabIds.has(tabId)) return;
  void syncPinnedTabsFromWindow(detachInfo.oldWindowId);
});

chrome.tabs.onAttached.addListener((tabId: number, attachInfo: TabAttachInfo) => {
  if (isApplyingGroup) return;
  const cached = pinnedTabCache.get(tabId);
  if (cached) {
    pinnedTabCache.set(tabId, { ...cached, windowId: attachInfo.newWindowId, index: attachInfo.newPosition });
  }
  scheduleWindowStateDebounced(attachInfo.newWindowId, 250);
});

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

chrome.storage.onChanged.addListener((changes: StorageChanges, areaName: string) => {
  if (areaName === "sync" && changes[PREFS_KEY]) {
    const next = changes[PREFS_KEY]?.newValue as { closePinnedToSuspend?: boolean } | undefined;
    closePinnedToSuspend = Boolean(next?.closePinnedToSuspend);
    return;
  }
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
      await applyGroupToAllWindows(group.items, { removedUrls: new Set() });
    }
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
  void (async () => {
    await loadPreferences();
    await initializeSyncState();
    await handleLastFocusedWindow();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await loadPreferences();
    await initializeSyncState();
    await handleLastFocusedWindow();
    await maybeRestoreDefaultGroupInAllWindows();
  })();
});

void (async () => {
  await loadPreferences();
  await initializeSyncState();
  await handleLastFocusedWindow();
})();
