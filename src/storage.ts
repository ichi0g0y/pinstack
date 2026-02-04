import type { LocalStateV1, PinnedGroup, PinnedSnapshot, PreferenceStateV1, SyncStateV1 } from "./types.js";
import { hashPinnedItemId, nanoid } from "./id.js";

export const SYNC_KEY = "pinstack_sync_state_v1";
export const LOCAL_KEY = "pinstack_local_state_v1";
export const PREFS_KEY = "pinstack_preferences_v1";
export const SNAPSHOT_KEY = "pinstack_pinned_snapshots_v1";

const DEFAULT_SYNC_STATE: SyncStateV1 = {
  version: 1,
  groups: [],
};

const DEFAULT_LOCAL_STATE: LocalStateV1 = {
  version: 1,
  lastLocalWriteAt: 0,
  hasRemoteUpdate: false,
  activeGroupId: undefined,
  deviceDefaultGroupId: undefined,
  autoApplyDefaultOnNewWindow: false,
  closePinnedToSuspend: false,
  windowGroupMap: {},
  windowGroupLockMap: {},
  unmanagedWindowMap: {},
};

const DEFAULT_PREFERENCES: PreferenceStateV1 = {
  version: 1,
  closePinnedToSuspend: false,
};

type SnapshotStateV1 = {
  version: 1;
  snapshots: Record<string, PinnedSnapshot>;
};

const DEFAULT_SNAPSHOT_STATE: SnapshotStateV1 = {
  version: 1,
  snapshots: {},
};

let syncStateNeedsWrite = false;

type RawPinnedGroup = {
  id?: unknown;
  name?: unknown;
  items?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  order?: unknown;
};

function normalizePinnedGroup(value: unknown, now: number): PinnedGroup | null {
  if (!value || typeof value !== "object") return null;
  const group = value as RawPinnedGroup;
  if (typeof group.id !== "string" || !group.id.trim()) return null;
  if (typeof group.name !== "string") return null;
  if (!Array.isArray(group.items)) return null;

  const groupId = group.id.trim();
  const createdAtMissing = typeof group.createdAt !== "number";
  const updatedAtMissing = typeof group.updatedAt !== "number";
  if (createdAtMissing || updatedAtMissing) {
    syncStateNeedsWrite = true;
  }
  const createdAt = createdAtMissing ? now : (group.createdAt as number);
  const updatedAtRaw = updatedAtMissing ? createdAt : (group.updatedAt as number);
  const updatedAt = Math.max(updatedAtRaw, createdAt);
  const order = typeof group.order === "number" ? group.order : undefined;

  const items = group.items
    .filter((item) => item && typeof (item as { url?: unknown }).url === "string")
    .map((item) => {
      const candidate = item as { id?: string; url: string; title?: string; faviconUrl?: string };
      const url = candidate.url.trim();
      const id =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id
          : hashPinnedItemId(groupId, url);
      return {
        id,
        url,
        title: typeof candidate.title === "string" ? candidate.title : undefined,
        faviconUrl: typeof candidate.faviconUrl === "string" ? candidate.faviconUrl : undefined,
      };
    })
    .filter((item) => item.url);

  return {
    id: groupId,
    name: group.name,
    items,
    createdAt,
    updatedAt,
    order,
  };
}

function normalizeSyncState(raw: unknown): SyncStateV1 {
  syncStateNeedsWrite = false;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SYNC_STATE };
  const candidate = raw as SyncStateV1;
  if (candidate.version !== 1 || !Array.isArray(candidate.groups)) {
    return { ...DEFAULT_SYNC_STATE };
  }

  const now = Date.now();
  const groups = candidate.groups
    .map((group) => normalizePinnedGroup(group, now))
    .filter((group): group is PinnedGroup => Boolean(group));

  return {
    version: 1,
    groups,
  };
}

function normalizeLocalState(raw: unknown): LocalStateV1 {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LOCAL_STATE };
  const candidate = raw as LocalStateV1;
  if (candidate.version !== 1) return { ...DEFAULT_LOCAL_STATE };
  const map = candidate.windowGroupMap && typeof candidate.windowGroupMap === "object" ? candidate.windowGroupMap : {};
  const windowGroupMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string") {
      windowGroupMap[key] = value;
    }
  }
  const lockMap =
    candidate.windowGroupLockMap && typeof candidate.windowGroupLockMap === "object"
      ? candidate.windowGroupLockMap
      : {};
  const windowGroupLockMap: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(lockMap)) {
    if (typeof value === "boolean") {
      windowGroupLockMap[key] = value;
    }
  }
  const unmanagedMap =
    candidate.unmanagedWindowMap && typeof candidate.unmanagedWindowMap === "object"
      ? candidate.unmanagedWindowMap
      : {};
  const unmanagedWindowMap: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(unmanagedMap)) {
    if (typeof value === "boolean") {
      unmanagedWindowMap[key] = value;
    }
  }
  return {
    version: 1,
    lastLocalWriteAt: typeof candidate.lastLocalWriteAt === "number" ? candidate.lastLocalWriteAt : 0,
    hasRemoteUpdate: Boolean(candidate.hasRemoteUpdate),
    activeGroupId: typeof candidate.activeGroupId === "string" ? candidate.activeGroupId : undefined,
    deviceDefaultGroupId:
      typeof candidate.deviceDefaultGroupId === "string" ? candidate.deviceDefaultGroupId : undefined,
    autoApplyDefaultOnNewWindow:
      typeof candidate.autoApplyDefaultOnNewWindow === "boolean"
        ? candidate.autoApplyDefaultOnNewWindow
        : DEFAULT_LOCAL_STATE.autoApplyDefaultOnNewWindow,
    closePinnedToSuspend:
      typeof candidate.closePinnedToSuspend === "boolean"
        ? candidate.closePinnedToSuspend
        : DEFAULT_LOCAL_STATE.closePinnedToSuspend,
    windowGroupMap,
    windowGroupLockMap,
    unmanagedWindowMap,
  };
}

function normalizePreferences(raw: unknown): PreferenceStateV1 {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
  const candidate = raw as PreferenceStateV1;
  if (candidate.version !== 1) return { ...DEFAULT_PREFERENCES };
  return {
    version: 1,
    closePinnedToSuspend:
      typeof candidate.closePinnedToSuspend === "boolean"
        ? candidate.closePinnedToSuspend
        : DEFAULT_PREFERENCES.closePinnedToSuspend,
  };
}

function normalizeSnapshotState(raw: unknown): SnapshotStateV1 {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SNAPSHOT_STATE };
  const candidate = raw as SnapshotStateV1;
  if (candidate.version !== 1 || !candidate.snapshots || typeof candidate.snapshots !== "object") {
    return { ...DEFAULT_SNAPSHOT_STATE };
  }
  const snapshots: Record<string, PinnedSnapshot> = {};
  for (const [key, value] of Object.entries(candidate.snapshots)) {
    if (!value || typeof value !== "object") continue;
    const snapshot = value as PinnedSnapshot;
    if (typeof snapshot.url !== "string" || !snapshot.url.trim()) continue;
    if ("id" in snapshot && typeof snapshot.id !== "string") continue;
    if ("title" in snapshot && typeof snapshot.title !== "string") continue;
    if ("faviconUrl" in snapshot && typeof snapshot.faviconUrl !== "string") continue;
    snapshots[key] = {
      id: typeof snapshot.id === "string" && snapshot.id.trim() ? snapshot.id : undefined,
      url: snapshot.url.trim(),
      title: typeof snapshot.title === "string" ? snapshot.title : undefined,
      faviconUrl: typeof snapshot.faviconUrl === "string" ? snapshot.faviconUrl : undefined,
    };
  }
  return { version: 1, snapshots };
}

export function generateId(): string {
  return nanoid();
}

export async function getSyncState(): Promise<SyncStateV1> {
  const result = await chrome.storage.sync.get(SYNC_KEY);
  return normalizeSyncState(result[SYNC_KEY]);
}

export async function setSyncState(state: SyncStateV1): Promise<void> {
  await chrome.storage.sync.set({ [SYNC_KEY]: state });
}

export async function getLocalState(): Promise<LocalStateV1> {
  const result = await chrome.storage.local.get(LOCAL_KEY);
  return normalizeLocalState(result[LOCAL_KEY]);
}

export async function setLocalState(state: LocalStateV1): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEY]: state });
}

export async function updateLocalState(partial: Partial<LocalStateV1>): Promise<LocalStateV1> {
  const current = await getLocalState();
  const next: LocalStateV1 = { ...current, ...partial, version: 1 };
  await setLocalState(next);
  return next;
}

export async function setWindowGroupId(windowId: number, groupId: string): Promise<LocalStateV1> {
  const current = await getLocalState();
  const windowGroupMap = { ...(current.windowGroupMap ?? {}), [String(windowId)]: groupId };
  return updateLocalState({ windowGroupMap });
}

export async function clearWindowGroupId(windowId: number): Promise<LocalStateV1> {
  const current = await getLocalState();
  if (!current.windowGroupMap || !(String(windowId) in current.windowGroupMap)) {
    return current;
  }
  const nextMap = { ...current.windowGroupMap };
  delete nextMap[String(windowId)];
  return updateLocalState({ windowGroupMap: nextMap });
}

export async function setWindowGroupLock(windowId: number, locked: boolean): Promise<LocalStateV1> {
  const current = await getLocalState();
  const windowGroupLockMap = { ...(current.windowGroupLockMap ?? {}), [String(windowId)]: locked };
  return updateLocalState({ windowGroupLockMap });
}

export async function clearWindowGroupLock(windowId: number): Promise<LocalStateV1> {
  const current = await getLocalState();
  if (!current.windowGroupLockMap || !(String(windowId) in current.windowGroupLockMap)) {
    return current;
  }
  const nextMap = { ...current.windowGroupLockMap };
  delete nextMap[String(windowId)];
  return updateLocalState({ windowGroupLockMap: nextMap });
}

export async function getPreferences(): Promise<PreferenceStateV1> {
  const result = await chrome.storage.sync.get(PREFS_KEY);
  return normalizePreferences(result[PREFS_KEY]);
}

export async function setPreferences(state: PreferenceStateV1): Promise<void> {
  await chrome.storage.sync.set({ [PREFS_KEY]: state });
}

export async function updatePreferences(partial: Partial<PreferenceStateV1>): Promise<PreferenceStateV1> {
  const current = await getPreferences();
  const next: PreferenceStateV1 = { ...current, ...partial, version: 1 };
  await setPreferences(next);
  return next;
}

export async function getPinnedSnapshots(): Promise<Record<string, PinnedSnapshot>> {
  const result = await chrome.storage.local.get(SNAPSHOT_KEY);
  return normalizeSnapshotState(result[SNAPSHOT_KEY]).snapshots;
}

export async function setPinnedSnapshots(snapshots: Record<string, PinnedSnapshot>): Promise<void> {
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: { version: 1, snapshots } });
}

export async function setActiveGroupId(groupId?: string): Promise<LocalStateV1> {
  return updateLocalState({ activeGroupId: groupId });
}

export async function setDeviceDefaultGroupId(groupId?: string): Promise<LocalStateV1> {
  return updateLocalState({ deviceDefaultGroupId: groupId });
}

export async function ensureDefaultGroup(): Promise<SyncStateV1> {
  const state = await getSyncState();
  let nextState = state;
  let needsWrite = syncStateNeedsWrite;
  const orderAssignments = new Map<string, number>();

  const groups = nextState.groups;
  const orderedGroups = groups.filter((group) => typeof group.order === "number");
  if (orderedGroups.length !== groups.length) {
    if (orderedGroups.length === 0) {
      const sorted = [...groups].sort((a, b) => b.createdAt - a.createdAt);
      sorted.forEach((group, index) => {
        orderAssignments.set(group.id, index);
      });
    } else {
      let maxOrder = Math.max(...orderedGroups.map((group) => group.order as number));
      for (const group of groups) {
        if (typeof group.order === "number") continue;
        maxOrder += 1;
        orderAssignments.set(group.id, maxOrder);
      }
    }
  }

  if (orderAssignments.size > 0) {
    nextState = {
      ...nextState,
      groups: nextState.groups.map((group) => {
        const order = orderAssignments.get(group.id);
        if (order === undefined) return group;
        return { ...group, order };
      }),
    };
    needsWrite = true;
  }

  if (needsWrite) {
    await markLocalWrite();
    await setSyncState(nextState);
  }
  return nextState;
}

export async function markLocalWrite(): Promise<void> {
  await updateLocalState({ lastLocalWriteAt: Date.now(), hasRemoteUpdate: false });
}

export async function wasRecentLocalWrite(windowMs = 3000): Promise<boolean> {
  const state = await getLocalState();
  return Date.now() - state.lastLocalWriteAt < windowMs;
}
