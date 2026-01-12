import {
  ensureDefaultGroup,
  generateId,
  getLocalState,
  getPreferences,
  markLocalWrite,
  setActiveGroupId,
  setWindowGroupId,
  setSyncState,
  updateLocalState,
  updatePreferences,
} from "./storage.js";
import type { PinnedGroup, SyncStateV1 } from "./types.js";

type TabInfo = { url?: string; pendingUrl?: string; title?: string; favIconUrl?: string };
type PinnedItemInput = { url: string; title?: string; faviconUrl?: string };
type WindowInfo = { id?: number };

const groupNameInput = document.querySelector<HTMLInputElement>("#groupName");
const saveButton = document.querySelector<HTMLButtonElement>("#saveGroup");
const groupsList = document.querySelector<HTMLDivElement>("#groupsList");
const emptyState = document.querySelector<HTMLParagraphElement>("#emptyState");
const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const syncNotice = document.querySelector<HTMLDivElement>("#syncNotice");
const closeToSuspendToggle = document.querySelector<HTMLInputElement>("#closeToSuspend");

if (
  !groupNameInput ||
  !saveButton ||
  !groupsList ||
  !emptyState ||
  !statusEl ||
  !syncNotice ||
  !closeToSuspendToggle
) {
  throw new Error("Popup UI is missing required elements.");
}

const groupNameInputEl = groupNameInput;
const saveButtonEl = saveButton;
const groupsListEl = groupsList;
const emptyStateEl = emptyState;
const statusElEl = statusEl;
const syncNoticeEl = syncNotice;
const closeToSuspendToggleEl = closeToSuspendToggle;
let draggedGroupId: string | null = null;

function setStatus(message: string, tone: "info" | "error" = "info"): void {
  statusElEl.textContent = message;
  statusElEl.dataset.tone = tone;
  statusElEl.hidden = !message;
}

function formatCount(count: number): string {
  return count === 1 ? "1 pinned tab" : `${count} pinned tabs`;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatGroupName(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed : "Untitled group";
}

function dedupeItems(items: PinnedItemInput[]): PinnedItemInput[] {
  const seen = new Set<string>();
  const result: PinnedItemInput[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }
  return result;
}

function parseSuspendedUrl(rawUrl: string): { targetUrl?: string; title?: string; faviconUrl?: string } | null {
  const baseUrl = chrome.runtime.getURL("suspended.html");
  if (!rawUrl.startsWith(baseUrl)) return null;
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

function getNextGroupOrder(state: SyncStateV1): number {
  const orders = state.groups
    .map((group) => (typeof group.order === "number" ? group.order : -1))
    .filter((order) => Number.isFinite(order));
  return (orders.length ? Math.max(...orders) : -1) + 1;
}

function sortGroups(state: SyncStateV1): PinnedGroup[] {
  return [...state.groups].sort((a, b) => {
    const aDefault = a.id === state.defaultGroupId;
    const bDefault = b.id === state.defaultGroupId;
    if (aDefault && !bDefault) return -1;
    if (!aDefault && bDefault) return 1;
    const orderA = typeof a.order === "number" ? a.order : Number.POSITIVE_INFINITY;
    const orderB = typeof b.order === "number" ? b.order : Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    return b.createdAt - a.createdAt;
  });
}

async function clearRemoteNotice(): Promise<void> {
  await updateLocalState({ hasRemoteUpdate: false });
  await chrome.action.setBadgeText({ text: "" });
}

async function refreshSyncNotice(): Promise<void> {
  const localState = await getLocalState();
  if (localState.hasRemoteUpdate) {
    syncNoticeEl.hidden = false;
    await clearRemoteNotice();
  } else {
    syncNoticeEl.hidden = true;
  }
}

async function renderPreferences(): Promise<void> {
  const prefs = await getPreferences();
  closeToSuspendToggleEl.checked = Boolean(prefs.closePinnedToSuspend);
}

async function renderGroups(): Promise<void> {
  const [state, localState] = await Promise.all([ensureDefaultGroup(), getLocalState()]);
  const activeGroupId =
    localState.activeGroupId && state.groups.some((group) => group.id === localState.activeGroupId)
      ? localState.activeGroupId
      : state.defaultGroupId;

  if (localState.activeGroupId && localState.activeGroupId !== activeGroupId) {
    await setActiveGroupId(undefined);
  }
  const groups = sortGroups(state);

  groupsListEl.innerHTML = "";
  if (groups.length === 0) {
    emptyStateEl.hidden = false;
    return;
  }

  emptyStateEl.hidden = true;
  groups.forEach((group) => {
    const isDefault = group.id === state.defaultGroupId;
    const isActive = group.id === activeGroupId;
    groupsListEl.appendChild(createGroupCard(group, { isDefault, isActive }));
  });
}

function createBadge(label: string, variant?: "accent"): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = variant ? `badge badge-${variant}` : "badge";
  badge.textContent = label;
  return badge;
}

function createGroupCard(
  group: PinnedGroup,
  { isDefault, isActive }: { isDefault: boolean; isActive: boolean }
): HTMLElement {
  const card = document.createElement("article");
  card.className = "group-card";
  card.dataset.id = group.id;
  card.dataset.default = isDefault ? "true" : "false";
  card.draggable = !isDefault;

  const header = document.createElement("div");
  header.className = "group-header";

  const title = document.createElement("h3");
  title.textContent = formatGroupName(group.name);

  const badges = document.createElement("div");
  badges.className = "badges";

  if (isDefault) {
    badges.append(createBadge("Default"));
  }

  if (isActive) {
    badges.append(createBadge("Syncing", "accent"));
  }

  if (!isDefault && !isActive) {
    badges.append(createBadge("Saved"));
  }

  header.append(title, badges);

  const meta = document.createElement("p");
  meta.className = "group-meta";
  meta.textContent = `${formatCount(group.items.length)} · Updated ${formatDate(group.updatedAt)}`;

  const actions = document.createElement("div");
  actions.className = "group-actions";

  const setDefaultButton = document.createElement("button");
  setDefaultButton.type = "button";
  setDefaultButton.textContent = "Set default";
  setDefaultButton.dataset.action = "set-default";
  setDefaultButton.dataset.id = group.id;
  setDefaultButton.disabled = isDefault;

  const setActiveButton = document.createElement("button");
  setActiveButton.type = "button";
  setActiveButton.textContent = isActive ? "Syncing" : "Sync here";
  setActiveButton.dataset.action = "set-active";
  setActiveButton.dataset.id = group.id;
  setActiveButton.disabled = isActive;

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.dataset.action = "delete";
  deleteButton.dataset.id = group.id;
  deleteButton.className = "danger";

  actions.append(setActiveButton, setDefaultButton, deleteButton);
  card.append(header, meta, actions);

  return card;
}

async function getPinnedItemsFromCurrentWindow(): Promise<PinnedItemInput[]> {
  const tabs = await new Promise<TabInfo[]>((resolve) => {
    chrome.tabs.query({ currentWindow: true, pinned: true }, (result: TabInfo[]) => resolve(result));
  });

  const items = tabs
    .map((tab) => {
      const rawUrl = tab.url ?? tab.pendingUrl ?? "";
      if (!rawUrl || rawUrl === "about:blank" || rawUrl.startsWith("chrome://newtab")) return null;
      const suspended = parseSuspendedUrl(rawUrl);
      const url = suspended?.targetUrl ?? rawUrl;
      if (!url) return null;
      const item: PinnedItemInput = { url };
      const title = suspended?.title ?? tab.title;
      if (title) item.title = title;
      const faviconUrl = normalizeFaviconUrl(suspended?.faviconUrl ?? tab.favIconUrl, url);
      if (faviconUrl) item.faviconUrl = faviconUrl;
      return item;
    })
    .filter((item): item is PinnedItemInput => Boolean(item));

  return dedupeItems(items);
}

async function syncGroupFromPinnedTabs(groupId: string): Promise<void> {
  const items = await getPinnedItemsFromCurrentWindow();
  const state = await ensureDefaultGroup();
  const target = state.groups.find((group) => group.id === groupId);
  if (!target) return;

  const same =
    target.items.length === items.length &&
    target.items.every((item, index) => {
      const candidate = items[index];
      return item.url === candidate?.url && item.title === candidate?.title;
    });

  if (same) return;

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
  await clearRemoteNotice();
}

async function saveGroupFromPinnedTabs(): Promise<void> {
  const name = groupNameInputEl.value.trim();
  if (!name) {
    setStatus("Please enter a group name.", "error");
    return;
  }

  saveButtonEl.disabled = true;
  setStatus("Capturing pinned tabs…");

  const items = await getPinnedItemsFromCurrentWindow();

  if (items.length === 0) {
    setStatus("No pinned tabs found in this window.", "error");
    saveButtonEl.disabled = false;
    return;
  }

  const state = await ensureDefaultGroup();
  const now = Date.now();

  const newGroup: PinnedGroup = {
    id: generateId(),
    name,
    items,
    createdAt: now,
    updatedAt: now,
    order: getNextGroupOrder(state),
  };

  const nextState: SyncStateV1 = {
    version: 1,
    groups: [...state.groups, newGroup],
    defaultGroupId: state.defaultGroupId ?? newGroup.id,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();

  groupNameInputEl.value = "";
  setStatus("Group saved.");
  saveButtonEl.disabled = false;
  await renderGroups();
}

async function setDefaultGroup(groupId: string): Promise<void> {
  const state = await ensureDefaultGroup();
  if (state.defaultGroupId === groupId) return;

  const nextState: SyncStateV1 = {
    ...state,
    defaultGroupId: groupId,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();
  setStatus("Default group updated.");
  await renderGroups();
}

async function deleteGroup(groupId: string): Promise<void> {
  const [state, localState] = await Promise.all([ensureDefaultGroup(), getLocalState()]);
  const nextGroups = state.groups.filter((group) => group.id !== groupId);

  const nextState: SyncStateV1 = {
    ...state,
    groups: nextGroups,
    defaultGroupId: state.defaultGroupId === groupId ? undefined : state.defaultGroupId,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();
  if (localState.activeGroupId === groupId) {
    await setActiveGroupId(undefined);
  }
  await ensureDefaultGroup();
  setStatus("Group deleted.");
  await renderGroups();
}

async function setActiveGroup(groupId: string): Promise<void> {
  const state = await ensureDefaultGroup();
  if (!state.groups.some((group) => group.id === groupId)) return;

  await setActiveGroupId(groupId);
  const windowId = await new Promise<number | undefined>((resolve) => {
    chrome.windows.getCurrent({}, (window: WindowInfo) => resolve(window?.id));
  });
  if (typeof windowId === "number") {
    await setWindowGroupId(windowId, groupId);
  }
  await syncGroupFromPinnedTabs(groupId);
  setStatus("Sync group updated.");
  await renderGroups();
}

async function persistGroupOrder(): Promise<void> {
  const state = await ensureDefaultGroup();
  const cards = Array.from(groupsListEl.querySelectorAll<HTMLElement>(".group-card"));
  const orderedIds = cards
    .map((card) => ({
      id: card.dataset.id,
      isDefault: card.dataset.default === "true",
    }))
    .filter((item) => item.id && !item.isDefault)
    .map((item) => item.id as string);

  if (orderedIds.length === 0) return;

  const orderMap = new Map(orderedIds.map((id, index) => [id, index]));
  let changed = false;
  const nextGroups = state.groups.map((group) => {
    if (group.id === state.defaultGroupId) return group;
    const order = orderMap.get(group.id);
    if (order === undefined || group.order === order) return group;
    changed = true;
    return { ...group, order };
  });

  if (!changed) return;

  const nextState: SyncStateV1 = {
    ...state,
    groups: nextGroups,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();
  await renderGroups();
}

groupsListEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.dataset.action || !target.dataset.id) return;

  if (target.dataset.action === "set-default") {
    void setDefaultGroup(target.dataset.id);
  }

  if (target.dataset.action === "set-active") {
    void setActiveGroup(target.dataset.id);
  }

  if (target.dataset.action === "delete") {
    void deleteGroup(target.dataset.id);
  }
});

groupsListEl.addEventListener("dragstart", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("button")) return;
  const card = target.closest<HTMLElement>(".group-card");
  if (!card || card.dataset.default === "true") return;
  draggedGroupId = card.dataset.id ?? null;
  if (!draggedGroupId) return;
  card.classList.add("dragging");
  event.dataTransfer?.setData("text/plain", draggedGroupId);
  event.dataTransfer?.setDragImage(card, 20, 20);
});

groupsListEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  const target = event.target as HTMLElement;
  const card = target.closest<HTMLElement>(".group-card");
  const dragging = groupsListEl.querySelector<HTMLElement>(".group-card.dragging");
  if (!card || !dragging || card === dragging) return;
  if (card.dataset.default === "true") return;
  const rect = card.getBoundingClientRect();
  const shouldInsertAfter = event.clientY > rect.top + rect.height / 2;
  groupsListEl.insertBefore(dragging, shouldInsertAfter ? card.nextSibling : card);
});

groupsListEl.addEventListener("drop", (event) => {
  event.preventDefault();
  if (!draggedGroupId) return;
  void persistGroupOrder();
});

groupsListEl.addEventListener("dragend", () => {
  const dragging = groupsListEl.querySelector<HTMLElement>(".group-card.dragging");
  if (dragging) dragging.classList.remove("dragging");
  draggedGroupId = null;
});

saveButtonEl.addEventListener("click", () => {
  void saveGroupFromPinnedTabs();
});

closeToSuspendToggleEl.addEventListener("change", () => {
  void updatePreferences({ closePinnedToSuspend: closeToSuspendToggleEl.checked });
});

groupNameInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveGroupFromPinnedTabs();
  }
});

void (async () => {
  await refreshSyncNotice();
  await renderPreferences();
  await renderGroups();
})();
