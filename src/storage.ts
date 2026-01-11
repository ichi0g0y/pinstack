import type { LocalStateV1, PinnedGroup, SyncStateV1 } from "./types.js";

export const SYNC_KEY = "pinstack_sync_state_v1";
export const LOCAL_KEY = "pinstack_local_state_v1";

const DEFAULT_SYNC_STATE: SyncStateV1 = {
  version: 1,
  groups: [],
  defaultGroupId: undefined,
};

const DEFAULT_LOCAL_STATE: LocalStateV1 = {
  version: 1,
  lastLocalWriteAt: 0,
  hasRemoteUpdate: false,
};

function isPinnedGroup(value: unknown): value is PinnedGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as PinnedGroup;
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
  return {
    version: 1,
    lastLocalWriteAt: typeof candidate.lastLocalWriteAt === "number" ? candidate.lastLocalWriteAt : 0,
    hasRemoteUpdate: Boolean(candidate.hasRemoteUpdate),
  };
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pinstack-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
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

export async function markLocalWrite(): Promise<void> {
  await updateLocalState({ lastLocalWriteAt: Date.now(), hasRemoteUpdate: false });
}

export async function wasRecentLocalWrite(windowMs = 3000): Promise<boolean> {
  const state = await getLocalState();
  return Date.now() - state.lastLocalWriteAt < windowMs;
}
