export const SYNC_KEY = "pinstack_sync_state_v1";
export const LOCAL_KEY = "pinstack_local_state_v1";
const DEFAULT_SYNC_STATE = {
    version: 1,
    groups: [],
    defaultGroupId: undefined,
};
const DEFAULT_LOCAL_STATE = {
    version: 1,
    lastLocalWriteAt: 0,
    hasRemoteUpdate: false,
};
function isPinnedGroup(value) {
    if (!value || typeof value !== "object")
        return false;
    const group = value;
    return (typeof group.id === "string" &&
        typeof group.name === "string" &&
        Array.isArray(group.items) &&
        typeof group.createdAt === "number" &&
        typeof group.updatedAt === "number");
}
function normalizeSyncState(raw) {
    if (!raw || typeof raw !== "object")
        return { ...DEFAULT_SYNC_STATE };
    const candidate = raw;
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
function normalizeLocalState(raw) {
    if (!raw || typeof raw !== "object")
        return { ...DEFAULT_LOCAL_STATE };
    const candidate = raw;
    if (candidate.version !== 1)
        return { ...DEFAULT_LOCAL_STATE };
    return {
        version: 1,
        lastLocalWriteAt: typeof candidate.lastLocalWriteAt === "number" ? candidate.lastLocalWriteAt : 0,
        hasRemoteUpdate: Boolean(candidate.hasRemoteUpdate),
    };
}
export function generateId() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `pinstack-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}
export async function getSyncState() {
    const result = await chrome.storage.sync.get(SYNC_KEY);
    return normalizeSyncState(result[SYNC_KEY]);
}
export async function setSyncState(state) {
    await chrome.storage.sync.set({ [SYNC_KEY]: state });
}
export async function getLocalState() {
    const result = await chrome.storage.local.get(LOCAL_KEY);
    return normalizeLocalState(result[LOCAL_KEY]);
}
export async function setLocalState(state) {
    await chrome.storage.local.set({ [LOCAL_KEY]: state });
}
export async function updateLocalState(partial) {
    const current = await getLocalState();
    const next = { ...current, ...partial, version: 1 };
    await setLocalState(next);
    return next;
}
export async function markLocalWrite() {
    await updateLocalState({ lastLocalWriteAt: Date.now(), hasRemoteUpdate: false });
}
export async function wasRecentLocalWrite(windowMs = 3000) {
    const state = await getLocalState();
    return Date.now() - state.lastLocalWriteAt < windowMs;
}
