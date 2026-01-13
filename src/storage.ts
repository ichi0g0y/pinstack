import type { LocalStateV1, PinnedGroup, PreferenceStateV1, SyncStateV1 } from "./types.js";
import { nanoid } from "./id.js";

export const SYNC_KEY = "pinstack_sync_state_v1";
export const LOCAL_KEY = "pinstack_local_state_v1";
export const PREFS_KEY = "pinstack_preferences_v1";

const DEFAULT_SYNC_STATE: SyncStateV1 = {
  version: 1,
  groups: [],
  defaultGroupId: undefined,
};

const DEFAULT_LOCAL_STATE: LocalStateV1 = {
  version: 1,
  lastLocalWriteAt: 0,
  hasRemoteUpdate: false,
  activeGroupId: undefined,
  closePinnedToSuspend: false,
  windowGroupMap: {},
};

const DEFAULT_PREFERENCES: PreferenceStateV1 = {
  version: 1,
  closePinnedToSuspend: false,
};

function isPinnedGroup(value: unknown): value is PinnedGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as PinnedGroup;
  if ("order" in group && typeof group.order !== "number") return false;
  return (
    typeof group.id === "string" &&
    typeof group.name === "string" &&
    Array.isArray(group.items) &&
    typeof group.createdAt === "number" &&
    typeof group.updatedAt === "number"
  );
}

function normalizeSyncState(raw: unknown): SyncStateV1 {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SYNC_STATE };
  const candidate = raw as SyncStateV1;
  if (candidate.version !== 1 || !Array.isArray(candidate.groups)) {
    return { ...DEFAULT_SYNC_STATE };
  }

  const groups = candidate.groups
    .filter(isPinnedGroup)
    .map((group) => ({
      ...group,
      order: typeof group.order === "number" ? group.order : undefined,
      items: Array.isArray(group.items)
        ? group.items.filter((item) => item && typeof item.url === "string" && item.url.trim())
        : [],
    }));

  return {
    version: 1,
    groups,
    defaultGroupId: typeof candidate.defaultGroupId === "string" ? candidate.defaultGroupId : undefined,
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
  return {
    version: 1,
    lastLocalWriteAt: typeof candidate.lastLocalWriteAt === "number" ? candidate.lastLocalWriteAt : 0,
    hasRemoteUpdate: Boolean(candidate.hasRemoteUpdate),
    activeGroupId: typeof candidate.activeGroupId === "string" ? candidate.activeGroupId : undefined,
    closePinnedToSuspend:
      typeof candidate.closePinnedToSuspend === "boolean"
        ? candidate.closePinnedToSuspend
        : DEFAULT_LOCAL_STATE.closePinnedToSuspend,
    windowGroupMap,
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

export async function setActiveGroupId(groupId?: string): Promise<LocalStateV1> {
  return updateLocalState({ activeGroupId: groupId });
}

export async function ensureDefaultGroup(): Promise<SyncStateV1> {
  const state = await getSyncState();
  const hasDefault =
    typeof state.defaultGroupId === "string" &&
    state.groups.some((group) => group.id === state.defaultGroupId);

  let nextState = state;
  let needsWrite = false;
  const orderAssignments = new Map<string, number>();

  if (!hasDefault) {
    const now = Date.now();
    const defaultGroup: PinnedGroup = {
      id: generateId(),
      name: "",
      items: [],
      createdAt: now,
      updatedAt: now,
      order: 0,
    };

    nextState = {
      version: 1,
      groups: [...state.groups, defaultGroup],
      defaultGroupId: defaultGroup.id,
    };
    needsWrite = true;
  }

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
