import {
  ensureDefaultGroup,
  generateId,
  getLocalState,
  getPreferences,
  getPinnedSnapshots,
  getSyncState,
  setWindowGroupId,
  clearWindowGroupId,
  setWindowGroupLock,
  clearWindowGroupLock,
  markLocalWrite,
  setActiveGroupId,
  setPinnedSnapshots,
  setSyncState,
  updateLocalState,
  updatePreferences,
  wasRecentLocalWrite,
  PREFS_KEY,
  SYNC_KEY,
} from "./storage.js";
import { hashPinnedItemId } from "./id.js";
import type { PinnedGroup, PinnedItem, PinnedSnapshot, SyncStateV1 } from "./types.js";

type TabInfo = {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  windowId?: number;
  index?: number;
  status?: "loading" | "complete";
};
type TabChangeInfo = { pinned?: boolean; url?: string; favIconUrl?: string; title?: string };
type TabsQuery = { windowId?: number; currentWindow?: boolean; pinned?: boolean; active?: boolean };
type TabCreate = { windowId?: number; url?: string; pinned?: boolean; index?: number; active?: boolean };
type TabUpdate = { pinned?: boolean; url?: string; active?: boolean };
type WindowInfo = { id?: number; type?: string };
type TabRemoveInfo = { windowId: number; isWindowClosing?: boolean };
type TabMoveInfo = { windowId: number; fromIndex: number; toIndex: number };
type TabDetachInfo = { oldWindowId: number; oldPosition: number };
type TabAttachInfo = { newWindowId: number; newPosition: number };
type TabActivatedInfo = { tabId: number; windowId: number };
type SessionTabData = { version: 1; groupId: string; itemId?: string };

const pinnedTabIds = new Set<number>();
const pinnedTabCache = new Map<number, TabInfo>();
const pinnedSnapshotCache = new Map<number, PinnedSnapshot>();
let snapshotsLoaded = false;
let snapshotLoadPromise: Promise<void> | null = null;
const intentionalRemovals = new Set<number>();
const skipNextActivation = new Set<number>();
const suppressedSyncByWindow = new Map<number, number>();
const suppressedCloseToSuspendByWindow = new Map<number, number>();
let isApplyingGroup = false;
let applyingGroupDepth = 0;
let isInitializing = true;
let initializationPromise: Promise<void> | null = null;
const pendingWindowSync = new Set<number>();
const pendingWindowRerun = new Set<number>();
const windowRestoreLocks = new Set<number>();
const windowStateTimers = new Map<number, number>();
const windowSyncTimers = new Map<number, number>();
const windowRecognitionAttempts = new Map<number, number>();
const skipDefaultWindows = new Set<number>();
const SUSPENDED_PAGE = chrome.runtime.getURL("suspended.html");
const SESSION_TAB_KEY = "pinstack_tab_group_v1";
const MAX_RECOGNITION_ATTEMPTS = 12;
let closePinnedToSuspend = false;
let newWindowBehavior: "default" | "unmanaged" = "default";

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

function updateTabRaw(tabId: number, updateProperties: TabUpdate): Promise<{ tab?: TabInfo; error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProperties, (tab: TabInfo) => {
      const error = chrome.runtime.lastError?.message;
      if (error) {
        resolve({ error });
        return;
      }
      resolve({ tab });
    });
  });
}

function updateTab(tabId: number, updateProperties: TabUpdate): Promise<TabInfo | undefined> {
  return updateTabRaw(tabId, updateProperties).then((result) => result.tab);
}

function moveTab(tabId: number, index: number): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.move(tabId, { index }, () => {
      const error = chrome.runtime.lastError?.message;
      if (error) {
        resolve({ error });
        return;
      }
      resolve({});
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function noteRecognitionAttempt(windowId: number): number {
  const next = (windowRecognitionAttempts.get(windowId) ?? 0) + 1;
  windowRecognitionAttempts.set(windowId, next);
  return next;
}

function clearRecognitionAttempts(windowId: number): void {
  windowRecognitionAttempts.delete(windowId);
}

function setSessionTabData(tabId: number, groupId: string, itemId?: string): Promise<void> {
  if (!chrome.sessions?.setTabValue) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.sessions.setTabValue(
      tabId,
      SESSION_TAB_KEY,
      { version: 1, groupId, itemId } satisfies SessionTabData,
      () => resolve()
    );
  });
}

function getSessionTabData(tabId: number): Promise<SessionTabData | undefined> {
  if (!chrome.sessions?.getTabValue) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    chrome.sessions.getTabValue(tabId, SESSION_TAB_KEY, (value: unknown) => {
      const error = chrome.runtime.lastError?.message;
      if (error || !value || typeof value !== "object") {
        resolve(undefined);
        return;
      }
      const candidate = value as SessionTabData;
      if (candidate.version !== 1 || typeof candidate.groupId !== "string" || !candidate.groupId.trim()) {
        resolve(undefined);
        return;
      }
      resolve({
        version: 1,
        groupId: candidate.groupId.trim(),
        itemId: typeof candidate.itemId === "string" && candidate.itemId.trim() ? candidate.itemId : undefined,
      });
    });
  });
}

async function moveTabWithRetry(tabId: number, index: number, retries = 6, delayMs = 120): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await moveTab(tabId, index);
    if (!result.error) return true;
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  return false;
}

function beginApplyingGroup(): void {
  applyingGroupDepth += 1;
  isApplyingGroup = true;
}

function endApplyingGroup(): void {
  applyingGroupDepth = Math.max(0, applyingGroupDepth - 1);
  if (applyingGroupDepth === 0) {
    isApplyingGroup = false;
  }
}

async function ensureSnapshotCache(): Promise<void> {
  if (snapshotsLoaded) return;
  if (!snapshotLoadPromise) {
    snapshotLoadPromise = (async () => {
      const snapshots = await getPinnedSnapshots();
      pinnedSnapshotCache.clear();
      for (const [key, snapshot] of Object.entries(snapshots)) {
        const id = Number(key);
        if (Number.isFinite(id)) {
          pinnedSnapshotCache.set(id, snapshot);
        }
      }
      snapshotsLoaded = true;
    })();
  }
  await snapshotLoadPromise;
}

async function persistSnapshotCache(): Promise<void> {
  const snapshots: Record<string, PinnedSnapshot> = {};
  for (const [id, snapshot] of pinnedSnapshotCache.entries()) {
    snapshots[String(id)] = snapshot;
  }
  await setPinnedSnapshots(snapshots);
}

async function removeSnapshotForTab(tabId: number): Promise<void> {
  await ensureSnapshotCache();
  if (pinnedSnapshotCache.delete(tabId)) {
    await persistSnapshotCache();
  }
}

async function setSnapshotForTab(tabId: number, snapshot: PinnedSnapshot): Promise<void> {
  await ensureSnapshotCache();
  const nextSnapshot = snapshot.id ? snapshot : { ...snapshot, id: generateId() };
  pinnedSnapshotCache.set(tabId, nextSnapshot);
  await persistSnapshotCache();
}

async function ensureSnapshotForTab(
  tab: TabInfo
): Promise<{ snapshot: PinnedSnapshot; created: boolean } | null> {
  if (typeof tab.id !== "number") return null;
  await ensureSnapshotCache();
  const existing = pinnedSnapshotCache.get(tab.id);
  const current = tabToSnapshot(tab, existing?.id);
  if (existing) {
    if (!existing.id && current?.id) {
      existing.id = current.id;
    }
    if (current && current.url === existing.url) {
      let updated = false;
      if (!existing.title && current.title) {
        existing.title = current.title;
        updated = true;
      }
      if (!existing.faviconUrl && current.faviconUrl) {
        existing.faviconUrl = current.faviconUrl;
        updated = true;
      }
      if (updated) {
        pinnedSnapshotCache.set(tab.id, existing);
        await persistSnapshotCache();
      }
    }
    return { snapshot: existing, created: false };
  }
  if (!current) return null;
  const nextSnapshot = current.id ? current : { ...current, id: generateId() };
  pinnedSnapshotCache.set(tab.id, nextSnapshot);
  await persistSnapshotCache();
  return { snapshot: nextSnapshot, created: true };
}

async function seedSnapshotsFromPinnedTabs(): Promise<void> {
  await ensureSnapshotCache();
  const tabs = await queryTabs({ pinned: true });
  const liveTabIds = new Set<number>();
  let changed = false;
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    liveTabIds.add(tab.id);
    if (pinnedSnapshotCache.has(tab.id)) continue;
    const snapshot = tabToSnapshot(tab);
    if (!snapshot) continue;
    const nextSnapshot = snapshot.id ? snapshot : { ...snapshot, id: generateId() };
    pinnedSnapshotCache.set(tab.id, nextSnapshot);
    changed = true;
  }
  for (const id of pinnedSnapshotCache.keys()) {
    if (liveTabIds.has(id)) continue;
    pinnedSnapshotCache.delete(id);
    changed = true;
  }
  if (changed) {
    await persistSnapshotCache();
  }
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

async function updateTabWithRetry(
  tabId: number,
  updateProperties: TabUpdate,
  retries = 6,
  delayMs = 120
): Promise<TabInfo | undefined> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await updateTabRaw(tabId, updateProperties);
    if (result.tab) return result.tab;
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  console.warn("pinstack: updateTab failed after retries", {
    tabId,
    updateProperties,
  });
  return undefined;
}

function removeTabRaw(tabId: number): Promise<{ error?: string }> {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError?.message;
      if (error) {
        resolve({ error });
        return;
      }
      resolve({});
    });
  });
}

async function removeTabWithRetry(tabId: number, retries = 4, delayMs = 120): Promise<boolean> {
  intentionalRemovals.add(tabId);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await removeTabRaw(tabId);
    if (!result.error) return true;
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  console.warn("pinstack: removeTab failed after retries", { tabId });
  return false;
}

function removeTab(tabId: number): Promise<void> {
  return removeTabWithRetry(tabId).then(() => undefined);
}

function suppressCloseToSuspend(windowId: number, durationMs = 2000): void {
  suppressedCloseToSuspendByWindow.set(windowId, Date.now() + durationMs);
}

function isCloseToSuspendSuppressed(windowId: number): boolean {
  const until = suppressedCloseToSuspendByWindow.get(windowId);
  if (!until) return false;
  if (until > Date.now()) return true;
  suppressedCloseToSuspendByWindow.delete(windowId);
  return false;
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

async function hasPinnedTabs(windowId: number): Promise<boolean> {
  const tabs = await queryTabs({ windowId, pinned: true });
  return tabs.length > 0;
}

function normalizeUrl(tab: TabInfo | undefined): string | undefined {
  if (!tab) return undefined;
  const url = tab.pendingUrl ?? tab.url ?? "";
  if (!url || url === "about:blank" || url.startsWith("chrome://newtab")) return undefined;
  const suspended = parseSuspendedUrl(url);
  if (suspended?.targetUrl) return suspended.targetUrl;
  return url;
}

function getSnapshotUrl(tab: TabInfo): string | undefined {
  if (tab.pinned && typeof tab.id === "number") {
    const snapshot = pinnedSnapshotCache.get(tab.id);
    if (snapshot?.url) return snapshot.url;
  }
  return normalizeUrl(tab);
}

function getTabMatchKey(tab: TabInfo, groupId?: string): string | undefined {
  const url = getSnapshotUrl(tab);
  if (!url) return undefined;
  if (groupId && tab.id !== undefined) {
    const snapshot = pinnedSnapshotCache.get(tab.id);
    if (snapshot?.id) return snapshot.id;
    return hashPinnedItemId(groupId, url);
  }
  return url;
}

function isBlankNewTab(tab: TabInfo | undefined): boolean {
  if (!tab) return false;
  const url = tab.pendingUrl ?? tab.url ?? "";
  return url === "about:blank" || url.startsWith("chrome://newtab");
}

function parseSuspendedUrl(
  rawUrl: string
): { targetUrl?: string; title?: string; faviconUrl?: string; snapshotId?: string } | null {
  if (!rawUrl.startsWith(SUSPENDED_PAGE)) return null;
  try {
    const url = new URL(rawUrl);
    const targetUrl = url.searchParams.get("target") ?? undefined;
    const title = url.searchParams.get("title") ?? undefined;
    const faviconUrl = url.searchParams.get("favicon") ?? undefined;
    const snapshotId = url.searchParams.get("id") ?? undefined;
    return { targetUrl, title, faviconUrl, snapshotId };
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

function buildSuspendedUrl(item: PinnedSnapshot): string {
  const url = new URL(SUSPENDED_PAGE);
  url.searchParams.set("target", item.url);
  if (item.title) url.searchParams.set("title", item.title);
  const normalizedFavicon = normalizeFaviconUrl(item.faviconUrl, item.url);
  if (normalizedFavicon) url.searchParams.set("favicon", normalizedFavicon);
  if (item.id) url.searchParams.set("id", item.id);
  return url.toString();
}

function tabToSnapshot(tab: TabInfo, fallbackId?: string): PinnedSnapshot | null {
  const url = normalizeUrl(tab);
  if (!url) return null;
  const suspended = tab.url ? parseSuspendedUrl(tab.url) : null;
  const snapshotId = suspended?.snapshotId ?? fallbackId;
  const item: PinnedSnapshot = {
    id: snapshotId,
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
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function snapshotToPinnedItem(snapshot: PinnedSnapshot, groupId: string): PinnedItem {
  const id = snapshot.id && snapshot.id.trim() ? snapshot.id : hashPinnedItemId(groupId, snapshot.url);
  return {
    id,
    url: snapshot.url,
    title: snapshot.title,
    faviconUrl: snapshot.faviconUrl,
  };
}

function assignItemIds(items: PinnedItem[], groupId: string): PinnedItem[] {
  return items.map((item) => ({
    ...item,
    id: hashPinnedItemId(groupId, item.url),
  }));
}

function getNextGroupOrder(state: SyncStateV1): number {
  const orders = state.groups
    .map((group) => (typeof group.order === "number" ? group.order : -1))
    .filter((order) => Number.isFinite(order));
  return (orders.length ? Math.max(...orders) : -1) + 1;
}

function areItemsEquivalent(a: PinnedItem[], b: PinnedItem[]): boolean {
  if (a.length !== b.length) return false;
  const urlCounts = new Map<string, number>();
  for (const item of a) {
    urlCounts.set(item.url, (urlCounts.get(item.url) ?? 0) + 1);
  }
  for (const item of b) {
    const count = urlCounts.get(item.url) ?? 0;
    if (count === 0) return false;
    urlCounts.set(item.url, count - 1);
  }
  return true;
}

function findMatchingGroup(groups: PinnedGroup[], items: PinnedItem[]): PinnedGroup | undefined {
  return groups.find((group) => areItemsEquivalent(group.items, items));
}

function findUniqueMatchingGroup(groups: PinnedGroup[], items: PinnedItem[]): PinnedGroup | undefined {
  const matches = groups.filter((group) => areItemsEquivalent(group.items, items));
  return matches.length === 1 ? matches[0] : undefined;
}

async function getSessionGroupIdForWindow(
  windowId: number,
  state: SyncStateV1
): Promise<string | undefined> {
  if (!chrome.sessions?.getTabValue) return undefined;
  const tabs = await queryTabs({ windowId, pinned: true });
  if (tabs.length === 0) return undefined;
  const validGroupIds = new Set(state.groups.map((group) => group.id));
  const sessionCandidates = await Promise.all(
    tabs
      .filter((tab): tab is TabInfo & { id: number } => typeof tab.id === "number")
      .map(async (tab) => {
        const data = await getSessionTabData(tab.id);
        if (!data?.groupId || !validGroupIds.has(data.groupId)) return undefined;
        return data.groupId;
      })
  );

  const groupCounts = new Map<string, number>();
  for (const groupId of sessionCandidates) {
    if (!groupId) continue;
    groupCounts.set(groupId, (groupCounts.get(groupId) ?? 0) + 1);
  }

  if (groupCounts.size !== 1) return undefined;
  const [groupId] = groupCounts.keys();
  return groupId;
}

async function getPinnedItems(queryInfo: TabsQuery, groupId?: string): Promise<PinnedItem[]> {
  await ensureSnapshotCache();
  const tabs = await queryTabs(queryInfo);
  const orderedTabs = [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const items: PinnedItem[] = [];
  const idSeed = groupId ?? "";
  const sessionWrites: Promise<void>[] = [];
  for (const tab of orderedTabs) {
    const result = await ensureSnapshotForTab(tab);
    const snapshot = result?.snapshot;
    if (!snapshot) continue;
    if (groupId && typeof tab.id === "number") {
      const itemId = snapshot.id ?? hashPinnedItemId(groupId, snapshot.url);
      sessionWrites.push(setSessionTabData(tab.id, groupId, itemId));
    }
    items.push(snapshotToPinnedItem(snapshot, idSeed));
  }
  if (sessionWrites.length > 0) {
    await Promise.all(sessionWrites);
  }
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

async function resolveSyncGroupId(state: SyncStateV1, windowId?: number): Promise<string | undefined> {
  const localState = await getLocalState();
  if (typeof windowId === "number") {
    const mappedId = localState.windowGroupMap?.[String(windowId)];
    if (mappedId && state.groups.some((group) => group.id === mappedId)) {
      return mappedId;
    }
    if (mappedId) {
      await clearWindowGroupId(windowId);
    }
    return state.defaultGroupId;
  }
  if (localState.activeGroupId && state.groups.some((group) => group.id === localState.activeGroupId)) {
    return localState.activeGroupId;
  }
  return state.defaultGroupId;
}

function getGroupIdForWindow(
  state: SyncStateV1,
  windowId: number,
  localState: Awaited<ReturnType<typeof getLocalState>>
): string | undefined {
  const mappedId = localState.windowGroupMap?.[String(windowId)];
  if (mappedId && state.groups.some((group) => group.id === mappedId)) {
    return mappedId;
  }
  if (mappedId) {
    return state.defaultGroupId;
  }
  return state.defaultGroupId;
}

function isWindowLocked(localState: Awaited<ReturnType<typeof getLocalState>>, windowId: number): boolean {
  return Boolean(localState.windowGroupLockMap?.[String(windowId)]);
}

function hasWindowMapping(localState: Awaited<ReturnType<typeof getLocalState>>, windowId: number): boolean {
  return Boolean(localState.windowGroupMap?.[String(windowId)]);
}

function isWindowUnmanaged(localState: Awaited<ReturnType<typeof getLocalState>>, windowId: number): boolean {
  return Boolean(localState.unmanagedWindowMap?.[String(windowId)]);
}

function hasMissingPinnedItems(current: PinnedItem[], desired: PinnedItem[]): boolean {
  if (desired.length === 0) return false;
  if (current.length === 0) return true;
  const idCounts = new Map<string, number>();
  const urlCounts = new Map<string, number>();
  for (const item of current) {
    if (item.id) {
      idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1);
    }
    urlCounts.set(item.url, (urlCounts.get(item.url) ?? 0) + 1);
  }
  for (const item of desired) {
    const idCount = item.id ? idCounts.get(item.id) ?? 0 : 0;
    if (idCount > 0) {
      idCounts.set(item.id, idCount - 1);
      continue;
    }
    const urlCount = urlCounts.get(item.url) ?? 0;
    if (urlCount > 0) {
      urlCounts.set(item.url, urlCount - 1);
      continue;
    }
    return true;
  }
  return false;
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
      return (
        item.id === candidate?.id &&
        item.url === candidate?.url &&
        item.title === candidate?.title &&
        item.faviconUrl === candidate?.faviconUrl
      );
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
  options: {
    mode?: "exact" | "additive";
    removedUrls?: Set<string>;
    forceCloseExtras?: boolean;
    groupId?: string;
    allowAdditions?: boolean;
  } = {}
): Promise<void> {
  beginApplyingGroup();
  try {
    const mode = options.mode ?? "exact";
    const allowAdditions = options.allowAdditions ?? true;
    const groupId = options.groupId;
    await ensureSnapshotCache();
    const tabs = await queryTabs({ windowId });
    const pinnedTabs = tabs.filter((tab) => tab.pinned);
    const unpinnedTabs = tabs.filter((tab) => !tab.pinned);
    const availablePinned = new Map<string, TabInfo[]>();
    const availableUnpinned = new Map<string, TabInfo[]>();
    const availablePinnedByUrl = new Map<string, TabInfo[]>();
    const availableUnpinnedByUrl = new Map<string, TabInfo[]>();

    for (const tab of pinnedTabs) {
      const key = getTabMatchKey(tab, options.groupId);
      if (!key) continue;
      const list = availablePinned.get(key) ?? [];
      list.push(tab);
      availablePinned.set(key, list);
      const url = getSnapshotUrl(tab);
      if (url) {
        const urlList = availablePinnedByUrl.get(url) ?? [];
        urlList.push(tab);
        availablePinnedByUrl.set(url, urlList);
      }
    }

    for (const tab of unpinnedTabs) {
      const key = getTabMatchKey(tab, options.groupId);
      if (!key) continue;
      const list = availableUnpinned.get(key) ?? [];
      list.push(tab);
      availableUnpinned.set(key, list);
      const url = getSnapshotUrl(tab);
      if (url) {
        const urlList = availableUnpinnedByUrl.get(url) ?? [];
        urlList.push(tab);
        availableUnpinnedByUrl.set(url, urlList);
      }
    }

    const keepTabIds = new Set<number>();
    const orderedTabIds: number[] = [];
    const createdIds = new Set<string>();

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const key = options.groupId ? item.id : item.url;
      const pinnedList = availablePinned.get(key);
      const existingPinned = pinnedList?.shift();

      if (existingPinned?.id !== undefined) {
        keepTabIds.add(existingPinned.id);
        orderedTabIds.push(existingPinned.id);
        const snapshot = pinnedSnapshotCache.get(existingPinned.id) ?? tabToSnapshot(existingPinned, item.id);
        if (snapshot) {
          await setSnapshotForTab(existingPinned.id, { ...snapshot, id: item.id, url: item.url });
        }
        if (groupId) {
          await setSessionTabData(existingPinned.id, groupId, item.id);
        }
        continue;
      }

      const unpinnedList = availableUnpinned.get(key);
      const existingUnpinned = unpinnedList?.shift();

      if (existingUnpinned?.id !== undefined) {
        if (!allowAdditions) {
          continue;
        }
        await updateTabWithRetry(existingUnpinned.id, { pinned: true });
        pinnedTabIds.add(existingUnpinned.id);
        keepTabIds.add(existingUnpinned.id);
        orderedTabIds.push(existingUnpinned.id);
        const snapshot = pinnedSnapshotCache.get(existingUnpinned.id) ?? tabToSnapshot(existingUnpinned, item.id);
        if (snapshot) {
          await setSnapshotForTab(existingUnpinned.id, { ...snapshot, id: item.id, url: item.url });
        }
        if (groupId) {
          await setSessionTabData(existingUnpinned.id, groupId, item.id);
        }
        continue;
      }

      const urlFallback = item.url;
      const fallbackPinned = availablePinnedByUrl.get(urlFallback)?.shift();
      if (fallbackPinned?.id !== undefined) {
        keepTabIds.add(fallbackPinned.id);
        orderedTabIds.push(fallbackPinned.id);
        const snapshot = pinnedSnapshotCache.get(fallbackPinned.id) ?? tabToSnapshot(fallbackPinned, item.id);
        if (snapshot) {
          await setSnapshotForTab(fallbackPinned.id, { ...snapshot, id: item.id, url: item.url });
        }
        if (groupId) {
          await setSessionTabData(fallbackPinned.id, groupId, item.id);
        }
        continue;
      }

      const fallbackUnpinned = availableUnpinnedByUrl.get(urlFallback)?.shift();
      if (fallbackUnpinned?.id !== undefined) {
        if (!allowAdditions) {
          continue;
        }
        await updateTabWithRetry(fallbackUnpinned.id, { pinned: true });
        pinnedTabIds.add(fallbackUnpinned.id);
        keepTabIds.add(fallbackUnpinned.id);
        orderedTabIds.push(fallbackUnpinned.id);
        const snapshot = pinnedSnapshotCache.get(fallbackUnpinned.id) ?? tabToSnapshot(fallbackUnpinned, item.id);
        if (snapshot) {
          await setSnapshotForTab(fallbackUnpinned.id, { ...snapshot, id: item.id, url: item.url });
        }
        if (groupId) {
          await setSessionTabData(fallbackUnpinned.id, groupId, item.id);
        }
        continue;
      }

      const dedupeKey = item.id;
      if (createdIds.has(dedupeKey)) continue;
      createdIds.add(dedupeKey);
      if (!allowAdditions) continue;
      const created = await createTabWithRetry({
        windowId,
        url: buildSuspendedUrl(item),
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
        await setSnapshotForTab(created.id, {
          id: item.id,
          url: item.url,
          title: item.title,
          faviconUrl: item.faviconUrl,
        });
        if (groupId) {
          await setSessionTabData(created.id, groupId, item.id);
        }
      }
    }

    if (mode === "exact") {
      for (const tab of pinnedTabs) {
        if (tab.id === undefined) continue;
        if (keepTabIds.has(tab.id)) continue;
        if (options.forceCloseExtras) {
          await removeTabWithRetry(tab.id);
        } else {
          const updated = await updateTabWithRetry(tab.id, { pinned: false });
          if (!updated) {
            await removeTabWithRetry(tab.id);
          }
        }
        pinnedTabIds.delete(tab.id);
      }

    for (let i = 0; i < orderedTabIds.length; i += 1) {
      await moveTabWithRetry(orderedTabIds[i], i);
    }

      await enforceExactPinned(windowId, items, options.forceCloseExtras);
    } else {
      if (options.removedUrls && options.removedUrls.size > 0) {
        for (const tab of pinnedTabs) {
          const url = getSnapshotUrl(tab);
          if (!url || !options.removedUrls.has(url)) continue;
          if (tab.id === undefined) continue;
          await removeTab(tab.id);
          pinnedTabIds.delete(tab.id);
        }
      }

      if (orderedTabIds.length > 1) {
        const latestPinnedTabs = await queryTabs({ windowId, pinned: true });
        const sortedPinnedTabs = latestPinnedTabs
          .filter((tab): tab is TabInfo & { id: number } => typeof tab.id === "number")
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const pinnedTabIdsOrdered = sortedPinnedTabs.map((tab) => tab.id);
        const pinnedTabIdSet = new Set(pinnedTabIdsOrdered);
        const desiredGroupOrder = orderedTabIds.filter((id) => pinnedTabIdSet.has(id));
        const desiredGroupOrderSet = new Set(desiredGroupOrder);

        if (desiredGroupOrder.length > 1) {
          const groupPositions: number[] = [];
          const currentGroupOrder: number[] = [];
          for (let i = 0; i < pinnedTabIdsOrdered.length; i += 1) {
            const id = pinnedTabIdsOrdered[i];
            if (!desiredGroupOrderSet.has(id)) continue;
            groupPositions.push(i);
            currentGroupOrder.push(id);
          }

          const sameOrder =
            currentGroupOrder.length === desiredGroupOrder.length &&
            currentGroupOrder.every((id, index) => id === desiredGroupOrder[index]);

          if (!sameOrder && groupPositions.length === desiredGroupOrder.length) {
            const targetOrder = [...pinnedTabIdsOrdered];
            for (let i = 0; i < groupPositions.length; i += 1) {
              targetOrder[groupPositions[i]] = desiredGroupOrder[i];
            }
            const needsMove = targetOrder.some((id, index) => id !== pinnedTabIdsOrdered[index]);
            if (needsMove) {
              for (let i = 0; i < targetOrder.length; i += 1) {
              await moveTabWithRetry(targetOrder[i], i);
            }
          }
        }
      }
    }
    }
  } finally {
    endApplyingGroup();
  }
}

async function enforceExactPinned(
  windowId: number,
  items: PinnedItem[],
  forceCloseExtras = false,
  attempts = 2
): Promise<void> {
  await ensureSnapshotCache();
  const allowedCounts = new Map<string, number>();
  for (const item of items) {
    allowedCounts.set(item.url, (allowedCounts.get(item.url) ?? 0) + 1);
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pinnedTabs = await queryTabs({ windowId, pinned: true });
    const urlToTabs = new Map<string, TabInfo[]>();
    for (const tab of pinnedTabs) {
      const url = getSnapshotUrl(tab);
      if (!url) continue;
      const list = urlToTabs.get(url) ?? [];
      list.push(tab);
      urlToTabs.set(url, list);
    }

    let changed = false;
    for (const [url, tabs] of urlToTabs.entries()) {
      const allowed = allowedCounts.get(url) ?? 0;
      if (allowed === 0) {
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          if (forceCloseExtras) {
            await removeTabWithRetry(tab.id);
          } else {
            const updated = await updateTabWithRetry(tab.id, { pinned: false });
            if (!updated) {
              await removeTabWithRetry(tab.id);
            }
          }
          pinnedTabIds.delete(tab.id);
          changed = true;
        }
        continue;
      }
      if (tabs.length > allowed) {
        const extras = tabs.slice(allowed);
        for (const tab of extras) {
          if (tab.id === undefined) continue;
          if (forceCloseExtras) {
            await removeTabWithRetry(tab.id);
          } else {
            const updated = await updateTabWithRetry(tab.id, { pinned: false });
            if (!updated) {
              await removeTabWithRetry(tab.id);
            }
          }
          pinnedTabIds.delete(tab.id);
          changed = true;
        }
      }
    }

    if (!changed) return;
    await sleep(120);
  }
}

async function applyGroupToAllWindows(
  items: PinnedItem[],
  options: { sourceWindowId?: number; removedUrls?: Set<string>; groupId?: string } = {}
): Promise<void> {
  if (isApplyingGroup) return;
  beginApplyingGroup();
  try {
    const windows = await getAllWindows();
    for (const window of windows) {
      if (typeof window.id !== "number") continue;
      if (pendingWindowSync.has(window.id)) continue;
      const mode = window.id === options.sourceWindowId ? "exact" : "additive";
      await applyGroupToWindow(window.id, items, { mode, removedUrls: options.removedUrls, groupId: options.groupId });
    }
  } finally {
    endApplyingGroup();
  }
}

async function applyGroupToMappedWindows(
  groupId: string,
  items: PinnedItem[],
  options: { sourceWindowId?: number; removedUrls?: Set<string> } = {}
): Promise<void> {
  if (isApplyingGroup) return;
  beginApplyingGroup();
  try {
    const [windows, localState, state] = await Promise.all([getAllWindows(), getLocalState(), ensureDefaultGroup()]);
    for (const window of windows) {
      if (typeof window.id !== "number") continue;
      if (pendingWindowSync.has(window.id)) continue;
      if (typeof options.sourceWindowId === "number" && window.id === options.sourceWindowId) continue;
      const mappedId = localState.windowGroupMap?.[String(window.id)];
      if (mappedId !== groupId) continue;
      await applyGroupToWindow(window.id, items, { mode: "additive", removedUrls: options.removedUrls, groupId });
    }
  } finally {
    endApplyingGroup();
  }
}

async function syncPinnedTabsFromWindow(
  windowId: number | undefined,
  options: { allowEmpty?: boolean } = {}
): Promise<void> {
  if (!windowId) return;
  const suppressUntil = suppressedSyncByWindow.get(windowId);
  if (suppressUntil && suppressUntil > Date.now()) {
    return;
  }
  if (suppressUntil) {
    suppressedSyncByWindow.delete(windowId);
  }
  if (pendingWindowSync.has(windowId)) return;
  const localState = await getLocalState();
  if (isWindowUnmanaged(localState, windowId)) return;
  const locked = isWindowLocked(localState, windowId);
  let state = await ensureDefaultGroup();
  const mapped = hasWindowMapping(localState, windowId);
  if (!mapped && !locked) {
    if (await hasPinnedTabs(windowId)) {
      return;
    }
    await scheduleWindowState(windowId);
    state = await ensureDefaultGroup();
  }
  const groupId = locked
    ? localState.windowGroupMap?.[String(windowId)] ?? state.defaultGroupId
    : await resolveSyncGroupId(state, windowId);
  if (!groupId) return;

  const pinnedTabs = await queryTabs({ windowId, pinned: true });
  if (pinnedTabs.length > 0) {
    const needsStabilize = pinnedTabs.some(
      (tab) => tab.status === "loading" || isBlankNewTab(tab) || Boolean(tab.pendingUrl)
    );
    if (needsStabilize) {
      schedulePinnedSyncDebounced(windowId, 500);
      return;
    }
  }

  const items = await getPinnedItems({ windowId, pinned: true }, groupId);
  if (pinnedTabs.length > 0 && items.length < pinnedTabs.length) {
    schedulePinnedSyncDebounced(windowId, 500);
    return;
  }
  if (items.length === 0 && !options.allowEmpty) return;
  const result = await updateGroupItems(groupId, items);
  if (result.changed) {
    const removedUrls = new Set(
      result.previousItems
        .filter((item) => !items.some((current) => current.url === item.url))
        .map((item) => item.url)
    );
    await applyGroupToMappedWindows(groupId, items, { sourceWindowId: windowId, removedUrls });
  }
}

async function initializeSyncState(): Promise<void> {
  await ensureDefaultGroup();
  await seedPinnedTabIds();
  await seedSnapshotsFromPinnedTabs();
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

  if (nextState.defaultGroupId) {
    await setWindowGroupId(windowId, nextState.defaultGroupId);
  }
  await applyGroupToWindow(windowId, group.items, { mode: "exact", groupId: group.id });
}

async function syncMappedWindowsFromLocal(): Promise<void> {
  await ensureSnapshotCache();
  const [windows, localState, state] = await Promise.all([getAllWindows(), getLocalState(), ensureDefaultGroup()]);
  const groupById = new Map(state.groups.map((group) => [group.id, group]));
  for (const window of windows) {
    if (typeof window.id !== "number") continue;
    const mappedId = localState.windowGroupMap?.[String(window.id)];
    if (!mappedId) continue;
    if (!groupById.has(mappedId)) continue;
    const group = groupById.get(mappedId);
    if (!group) continue;
    const items = await getPinnedItems({ windowId: window.id, pinned: true }, mappedId);
    if (items.length === 0) continue;
    if (hasMissingPinnedItems(items, group.items)) continue;
    await updateGroupItems(mappedId, items);
  }
}

async function restoreMappedWindowsFromGroup(): Promise<void> {
  await ensureSnapshotCache();
  const [windows, localState, state] = await Promise.all([getAllWindows(), getLocalState(), ensureDefaultGroup()]);
  const groupById = new Map(state.groups.map((group) => [group.id, group]));
  for (const window of windows) {
    if (typeof window.id !== "number") continue;
    const mappedId = localState.windowGroupMap?.[String(window.id)];
    if (!mappedId) continue;
    const group = groupById.get(mappedId);
    if (!group) continue;
    const items = await getPinnedItems({ windowId: window.id, pinned: true }, mappedId);
    if (!hasMissingPinnedItems(items, group.items)) continue;
    suppressedSyncByWindow.set(window.id, Date.now() + 1500);
    suppressCloseToSuspend(window.id);
    await applyGroupToWindow(window.id, group.items, { mode: "additive", groupId: group.id });
  }
}

async function finalizeInitialization(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await syncMappedWindowsFromLocal();
      await restoreMappedWindowsFromGroup();
      isInitializing = false;
    })();
  }
  await initializationPromise;
}

async function handleWindowState(windowId: number | undefined): Promise<void> {
  if (!windowId) return;

  await new Promise((resolve) => setTimeout(resolve, 150));
  const state = await ensureDefaultGroup();
  const localState = await getLocalState();
  if (isWindowUnmanaged(localState, windowId)) {
    return;
  }
  const shouldSkipDefault = skipDefaultWindows.has(windowId);
  const mappedId = localState.windowGroupMap?.[String(windowId)];
  const locked = isWindowLocked(localState, windowId);
  if (mappedId) {
    const mappedGroup = state.groups.find((group) => group.id === mappedId);
    if (mappedGroup) {
      await setActiveGroupId(mappedGroup.id);
      await setWindowGroupId(windowId, mappedGroup.id);
      const items = await getPinnedItems({ windowId, pinned: true }, mappedGroup.id);
      if (items.length === 0) {
        if (mappedGroup.items.length > 0) {
          await applyGroupToWindow(windowId, mappedGroup.items, { mode: "exact", groupId: mappedGroup.id });
        }
      } else if (!locked) {
        await updateGroupItems(mappedGroup.id, items);
      }
      return;
    }
    await clearWindowGroupId(windowId);
    await clearWindowGroupLock(windowId);
  }

  const pinnedTabs = await queryTabs({ windowId, pinned: true });
  const pinnedCount = pinnedTabs.length;
  const needsStabilize = pinnedTabs.some(
    (tab) => tab.status === "loading" || isBlankNewTab(tab) || Boolean(tab.pendingUrl)
  );
  const items = await getPinnedItems({ windowId, pinned: true });
  const shouldRetry = pinnedCount > 0 && (needsStabilize || items.length < pinnedCount);

  if (items.length === 0) {
    if (pinnedCount > 0) {
      const attempts = noteRecognitionAttempt(windowId);
      if (shouldRetry && attempts <= MAX_RECOGNITION_ATTEMPTS) {
        scheduleWindowStateDebounced(windowId, 800);
        return;
      }
      if (!isWindowUnmanaged(localState, windowId)) {
        const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
        unmanagedWindowMap[String(windowId)] = true;
        await updateLocalState({ unmanagedWindowMap });
      }
      clearRecognitionAttempts(windowId);
      return;
    }
    if (shouldSkipDefault) {
      skipDefaultWindows.delete(windowId);
      clearRecognitionAttempts(windowId);
      return;
    }
    if (state.defaultGroupId) {
      await setActiveGroupId(state.defaultGroupId);
      await setWindowGroupId(windowId, state.defaultGroupId);
    }
    await maybeRestoreDefaultGroup(windowId, state);
    clearRecognitionAttempts(windowId);
    return;
  }

  const sessionGroupId = await getSessionGroupIdForWindow(windowId, state);
  if (sessionGroupId) {
    await setActiveGroupId(sessionGroupId);
    await setWindowGroupId(windowId, sessionGroupId);
    const itemsForGroup = await getPinnedItems({ windowId, pinned: true }, sessionGroupId);
    await updateGroupItems(sessionGroupId, itemsForGroup);
    clearRecognitionAttempts(windowId);
    return;
  }

  const activeGroup =
    localState.activeGroupId && state.groups.some((group) => group.id === localState.activeGroupId)
      ? state.groups.find((group) => group.id === localState.activeGroupId)
      : undefined;
  const matchedGroup =
    activeGroup && areItemsEquivalent(activeGroup.items, items)
      ? activeGroup
      : findUniqueMatchingGroup(state.groups, items);

  if (matchedGroup) {
    await setActiveGroupId(matchedGroup.id);
    await setWindowGroupId(windowId, matchedGroup.id);
    const itemsForGroup = await getPinnedItems({ windowId, pinned: true }, matchedGroup.id);
    await updateGroupItems(matchedGroup.id, itemsForGroup);
    clearRecognitionAttempts(windowId);
    return;
  }
  const attempts = noteRecognitionAttempt(windowId);
  if ((shouldRetry || isInitializing) && attempts <= MAX_RECOGNITION_ATTEMPTS) {
    scheduleWindowStateDebounced(windowId, 800);
    return;
  }
  if (!isWindowUnmanaged(localState, windowId)) {
    const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
    unmanagedWindowMap[String(windowId)] = true;
    await updateLocalState({ unmanagedWindowMap });
  }
  clearRecognitionAttempts(windowId);
  return;
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
  newWindowBehavior = prefs.newWindowBehavior;
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

function schedulePinnedSyncDebounced(windowId: number | undefined, delayMs = 200): void {
  if (!windowId) return;
  const existing = windowSyncTimers.get(windowId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    windowSyncTimers.delete(windowId);
    void syncPinnedTabsFromWindow(windowId, { allowEmpty: true });
  }, delayMs);
  windowSyncTimers.set(windowId, timer as unknown as number);
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
  if (newWindowBehavior === "unmanaged") {
    skipDefaultWindows.add(window.id);
    void (async () => {
      const localState = await getLocalState();
      const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
      unmanagedWindowMap[String(window.id)] = true;
      await updateLocalState({ unmanagedWindowMap });
    })();
  }
  scheduleWindowStateDebounced(window.id, 250);
});

chrome.windows.onRemoved.addListener((windowId: number) => {
  void clearWindowGroupId(windowId);
  void clearWindowGroupLock(windowId);
  clearRecognitionAttempts(windowId);
  void (async () => {
    const localState = await getLocalState();
    if (!localState.unmanagedWindowMap?.[String(windowId)]) return;
    const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
    delete unmanagedWindowMap[String(windowId)];
    await updateLocalState({ unmanagedWindowMap });
  })();
});

chrome.tabs.onCreated.addListener((tab: TabInfo) => {
  if (isApplyingGroup) return;
  if (!tab.pinned) return;
  void (async () => {
    if (typeof tab.id === "number") {
      pinnedTabIds.add(tab.id);
      cachePinnedTab(tab);
    }
    await ensureSnapshotForTab(tab);
    await syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
  })();
});

chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: TabChangeInfo, tab: TabInfo) => {
  if (isApplyingGroup) return;
  const pinnedChanged = typeof changeInfo.pinned !== "undefined";
  if (tab.pinned) {
    cachePinnedTab(tab);
    void (async () => {
      const result = await ensureSnapshotForTab(tab);
      if (result?.created && !pinnedChanged) {
        await syncPinnedTabsFromWindow(tab.windowId, { allowEmpty: true });
      }
    })();
    if (changeInfo.url || changeInfo.favIconUrl || changeInfo.title) {
      const windowId = tab.windowId;
      if (typeof windowId !== "number") return;
      void (async () => {
        const localState = await getLocalState();
        if (isWindowUnmanaged(localState, windowId)) return;
        await ensureSnapshotCache();
        const snapshot = pinnedSnapshotCache.get(tabId);
        const normalizedUrl = normalizeUrl(tab);
        if (!normalizedUrl) return;
        const nextFavicon = normalizeFaviconUrl(tab.favIconUrl, normalizedUrl);
        const nextTitle = tab.title ?? snapshot?.title;
        const shouldUpdate =
          !snapshot ||
          snapshot.url !== normalizedUrl ||
          snapshot.title !== nextTitle ||
          (nextFavicon && snapshot?.faviconUrl !== nextFavicon);
        if (!shouldUpdate) return;
        await setSnapshotForTab(tabId, {
          id: snapshot?.id,
          url: normalizedUrl,
          title: nextTitle,
          faviconUrl: nextFavicon ?? snapshot?.faviconUrl,
        });
        schedulePinnedSyncDebounced(windowId, 250);
      })();
    }
  }
  if (!pinnedChanged) return;
  if (changeInfo.pinned) {
    pinnedTabIds.add(tabId);
    cachePinnedTab(tab);
  } else {
    pinnedTabIds.delete(tabId);
    pinnedTabCache.delete(tabId);
    void removeSnapshotForTab(tabId);
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
    const item = tabToSnapshot(tab);
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
      await removeSnapshotForTab(tabId);
      return;
    }
    if (!wasPinned) return;
    const localState = await getLocalState();
    if (isWindowUnmanaged(localState, removeInfo.windowId)) {
      pinnedTabCache.delete(tabId);
      await removeSnapshotForTab(tabId);
      return;
    }
    if (intentionalRemovals.has(tabId)) {
      intentionalRemovals.delete(tabId);
      pinnedTabCache.delete(tabId);
      await removeSnapshotForTab(tabId);
      return;
    }
    if (closePinnedToSuspend && !isCloseToSuspendSuppressed(removeInfo.windowId)) {
      await ensureSnapshotCache();
      const cached = pinnedTabCache.get(tabId);
      pinnedTabCache.delete(tabId);
      const snapshot = pinnedSnapshotCache.get(tabId) ?? (cached ? tabToSnapshot(cached) : null);
      if (snapshot) {
        const item = snapshot;
        if (item) {
          const windowId = cached && typeof cached.windowId === "number" ? cached.windowId : removeInfo.windowId;
          const index = cached && typeof cached.index === "number" ? cached.index : 0;
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
            await setSnapshotForTab(created.id, item);
            skipNextActivation.add(created.id);
          }
          await removeSnapshotForTab(tabId);
          return;
        }
      }
    } else {
      pinnedTabCache.delete(tabId);
    }
    await removeSnapshotForTab(tabId);
    await syncPinnedTabsFromWindow(removeInfo.windowId, { allowEmpty: true });
  })();
});

chrome.tabs.onMoved.addListener((tabId: number, moveInfo: TabMoveInfo) => {
  if (isApplyingGroup) return;
  const cached = pinnedTabCache.get(tabId);
  if (cached) {
    pinnedTabCache.set(tabId, { ...cached, index: moveInfo.toIndex, windowId: moveInfo.windowId });
  }
  schedulePinnedSyncDebounced(moveInfo.windowId);
});

chrome.tabs.onDetached.addListener((tabId: number, detachInfo: TabDetachInfo) => {
  if (isApplyingGroup) return;
  const cached = pinnedTabCache.get(tabId);
  if (cached) {
    pinnedTabCache.set(tabId, { ...cached, windowId: detachInfo.oldWindowId });
  }
  schedulePinnedSyncDebounced(detachInfo.oldWindowId);
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
    const next = changes[PREFS_KEY]?.newValue as { closePinnedToSuspend?: boolean; newWindowBehavior?: string } | undefined;
    closePinnedToSuspend = Boolean(next?.closePinnedToSuspend);
    if (next?.newWindowBehavior === "default" || next?.newWindowBehavior === "unmanaged") {
      newWindowBehavior = next.newWindowBehavior;
    }
    return;
  }
  if (areaName !== "sync" || !changes[SYNC_KEY]) return;
  void (async () => {
    if (isInitializing) return;
    const recentLocalWrite = await wasRecentLocalWrite();
    if (recentLocalWrite) return;

    await updateLocalState({ hasRemoteUpdate: false });
    await chrome.action.setBadgeText({ text: "" });

    const state = await ensureDefaultGroup();
    const localState = await getLocalState();
    const validIds = new Set(state.groups.map((group) => group.id));
    const windowGroupMap = { ...(localState.windowGroupMap ?? {}) };
    const windowGroupLockMap = { ...(localState.windowGroupLockMap ?? {}) };
    let mapChanged = false;

    for (const [key, value] of Object.entries(windowGroupMap)) {
      if (validIds.has(value)) continue;
      mapChanged = true;
      delete windowGroupMap[key];
      delete windowGroupLockMap[key];
    }

    if (mapChanged) {
      await updateLocalState({ windowGroupMap, windowGroupLockMap });
    }

    const windows = await getAllWindows();
    for (const window of windows) {
      if (typeof window.id !== "number") continue;
      const mappedId = windowGroupMap[String(window.id)];
      if (!mappedId) continue;
      const group = state.groups.find((candidate) => candidate.id === mappedId);
      if (!group) continue;
      const pinnedTabs = await queryTabs({ windowId: window.id, pinned: true });
      const allowAdditions = pinnedTabs.length === 0;
      await applyGroupToWindow(window.id, group.items, {
        mode: "exact",
        groupId: group.id,
        forceCloseExtras: true,
        allowAdditions,
      });
    }
  })();
});

chrome.runtime.onMessage.addListener(
  (
    message: {
      type?: string;
      windowId?: number;
      groupId?: string;
      suppressSync?: boolean;
      suppressCloseToSuspend?: boolean;
    },
    _sender: unknown,
    sendResponse: (response: { ok: boolean }) => void
  ) => {
    if (message?.type === "pinstack:apply-default-group") {
      if (typeof message.windowId !== "number" || typeof message.groupId !== "string") return;
      const windowId = message.windowId;
      const groupId = message.groupId;
      void (async () => {
      const state = await ensureDefaultGroup();
      if (state.defaultGroupId !== groupId) return;
      const group = state.groups.find((candidate) => candidate.id === groupId);
      if (!group) return;
      const localState = await getLocalState();
      if (localState.unmanagedWindowMap?.[String(windowId)]) {
        const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
        delete unmanagedWindowMap[String(windowId)];
        await updateLocalState({ unmanagedWindowMap });
      }
      if (message.suppressSync) {
        suppressedSyncByWindow.set(windowId, Date.now() + 1500);
      }
      if (message.suppressCloseToSuspend) {
        suppressCloseToSuspend(windowId);
      }
      await setActiveGroupId(group.id);
      await setWindowGroupId(windowId, group.id);
      await applyGroupToWindow(windowId, group.items, { mode: "exact", forceCloseExtras: true, groupId: group.id });
    })();
    return;
  }

  if (message?.type === "pinstack:apply-group") {
    if (typeof message.windowId !== "number" || typeof message.groupId !== "string") return;
    const windowId = message.windowId;
    const groupId = message.groupId;
    void (async () => {
      try {
        const state = await ensureDefaultGroup();
        const group = state.groups.find((candidate) => candidate.id === groupId);
        if (!group) {
          sendResponse({ ok: false });
          return;
        }
        const localState = await getLocalState();
        if (localState.unmanagedWindowMap?.[String(windowId)]) {
          const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
          delete unmanagedWindowMap[String(windowId)];
          await updateLocalState({ unmanagedWindowMap });
        }
        suppressedSyncByWindow.set(windowId, Date.now() + 1500);
        suppressCloseToSuspend(windowId);
        await setActiveGroupId(group.id);
        await setWindowGroupId(windowId, group.id);
        await setWindowGroupLock(windowId, true);
        await applyGroupToWindow(windowId, group.items, { mode: "exact", groupId: group.id });
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "pinstack:refresh-group") {
    if (typeof message.windowId !== "number" || typeof message.groupId !== "string") return;
    const windowId = message.windowId;
    const groupId = message.groupId;
    void (async () => {
      try {
        const [state, localState] = await Promise.all([ensureDefaultGroup(), getLocalState()]);
        const mappedId = localState.windowGroupMap?.[String(windowId)];
        if (mappedId !== groupId) {
          sendResponse({ ok: false });
          return;
        }
        const group = state.groups.find((candidate) => candidate.id === groupId);
        if (!group) {
          sendResponse({ ok: false });
          return;
        }
        suppressedSyncByWindow.set(windowId, Date.now() + 1500);
        suppressCloseToSuspend(windowId);
        await applyGroupToWindow(windowId, group.items, { mode: "exact", groupId: group.id });
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "pinstack:unmanage-window") {
    if (typeof message.windowId !== "number") return;
    const windowId = message.windowId;
    void (async () => {
      try {
        const localState = await getLocalState();
        const unmanagedWindowMap = { ...(localState.unmanagedWindowMap ?? {}) };
        unmanagedWindowMap[String(windowId)] = true;
        await updateLocalState({ unmanagedWindowMap });
        await clearWindowGroupId(windowId);
        await clearWindowGroupLock(windowId);
        suppressedSyncByWindow.set(windowId, Date.now() + 2000);
        suppressCloseToSuspend(windowId);
        const tabs = await queryTabs({ windowId, pinned: true });
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          await removeTabWithRetry(tab.id);
          pinnedTabIds.delete(tab.id);
          pinnedTabCache.delete(tab.id);
        }
        skipDefaultWindows.add(windowId);
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "pinstack:group-deleted") {
    if (typeof message.groupId !== "string") return;
    const deletedGroupId = message.groupId;
    void (async () => {
      const localState = await getLocalState();
      const windowGroupMap = { ...(localState.windowGroupMap ?? {}) };
      const windowGroupLockMap = { ...(localState.windowGroupLockMap ?? {}) };
      let changed = false;

      for (const [key, value] of Object.entries(windowGroupMap)) {
        if (value !== deletedGroupId) continue;
        delete windowGroupMap[key];
        delete windowGroupLockMap[key];
        changed = true;
      }

      if (localState.activeGroupId === deletedGroupId) {
        await setActiveGroupId(undefined);
      }

      if (changed) {
        await updateLocalState({ windowGroupMap, windowGroupLockMap });
      }
    })();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d1492e" });
  void (async () => {
    await loadPreferences();
    await initializeSyncState();
    await handleLastFocusedWindow();
    await finalizeInitialization();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await chrome.action.setBadgeText({ text: "" });
    await loadPreferences();
    await initializeSyncState();
    await handleLastFocusedWindow();
    await maybeRestoreDefaultGroupInAllWindows();
    await finalizeInitialization();
  })();
});

void (async () => {
  await chrome.action.setBadgeText({ text: "" });
  await loadPreferences();
  await initializeSyncState();
  await handleLastFocusedWindow();
  await finalizeInitialization();
})();
