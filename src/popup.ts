import {
  ensureDefaultGroup,
  generateId,
  getLocalState,
  getPreferences,
  getPinnedSnapshots,
  markLocalWrite,
  setActiveGroupId,
  setPinnedSnapshots,
  setWindowGroupId,
  setSyncState,
  updateLocalState,
  updatePreferences,
} from "./storage.js";
import type { PinnedGroup, PinnedItem, PinnedSnapshot, SyncStateV1 } from "./types.js";

type TabInfo = { id?: number; url?: string; pendingUrl?: string; title?: string; favIconUrl?: string };
type PinnedItemInput = PinnedSnapshot;
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

function snapshotToPinnedItem(snapshot: PinnedSnapshot, groupId: string): PinnedItem {
  const id = snapshot.id && snapshot.id.trim() ? snapshot.id : generateId();
  return {
    id,
    url: snapshot.url,
    title: snapshot.title,
    faviconUrl: snapshot.faviconUrl,
  };
}

function parseSuspendedUrl(
  rawUrl: string
): { targetUrl?: string; title?: string; faviconUrl?: string; snapshotId?: string } | null {
  const baseUrl = chrome.runtime.getURL("suspended.html");
  if (!rawUrl.startsWith(baseUrl)) return null;
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

function tabToSnapshot(tab: TabInfo, fallbackId?: string): PinnedSnapshot | null {
  const rawUrl = tab.url ?? tab.pendingUrl ?? "";
  if (!rawUrl || rawUrl === "about:blank" || rawUrl.startsWith("chrome://newtab")) return null;
  const suspended = parseSuspendedUrl(rawUrl);
  const url = suspended?.targetUrl ?? rawUrl;
  if (!url) return null;
  const title = suspended?.title ?? tab.title;
  const faviconUrl = normalizeFaviconUrl(suspended?.faviconUrl ?? tab.favIconUrl, url);
  const snapshotId = suspended?.snapshotId ?? fallbackId;
  return {
    id: snapshotId,
    url,
    title: title ?? undefined,
    faviconUrl: faviconUrl ?? undefined,
  };
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
  const [state, localState, windowId] = await Promise.all([
    ensureDefaultGroup(),
    getLocalState(),
    new Promise<number | undefined>((resolve) => {
      chrome.windows.getCurrent({}, (window: WindowInfo) => resolve(window?.id));
    }),
  ]);
  const activeGroupId =
    localState.activeGroupId && state.groups.some((group) => group.id === localState.activeGroupId)
      ? localState.activeGroupId
      : state.defaultGroupId;

  if (localState.activeGroupId && localState.activeGroupId !== activeGroupId) {
    await setActiveGroupId(undefined);
  }

  const mappedGroupId =
    typeof windowId === "number" ? localState.windowGroupMap?.[String(windowId)] : undefined;
  const currentGroupId =
    mappedGroupId && state.groups.some((group) => group.id === mappedGroupId) ? mappedGroupId : undefined;
  const groups = sortGroups(state);

  groupsListEl.innerHTML = "";
  if (groups.length === 0) {
    emptyStateEl.hidden = false;
    return;
  }

  emptyStateEl.hidden = true;
  groups.forEach((group) => {
    const isDefault = group.id === state.defaultGroupId;
    const isMapped = group.id === currentGroupId;
    groupsListEl.appendChild(createGroupCard(group, { isDefault, isMapped }));
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
  { isDefault, isMapped }: { isDefault: boolean; isMapped: boolean }
): HTMLElement {
  const card = document.createElement("article");
  card.className = "group-card";
  card.dataset.id = group.id;
  card.dataset.default = isDefault ? "true" : "false";
  card.dataset.mapped = isMapped ? "true" : "false";
  card.draggable = !isDefault;

  const header = document.createElement("div");
  header.className = "group-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "group-title";

  const title = document.createElement("h3");
  title.className = "group-title-text";
  title.textContent = formatGroupName(group.name);

  const titleInput = document.createElement("input");
  titleInput.className = "group-title-input";
  titleInput.type = "text";
  titleInput.value = group.name;
  titleInput.dataset.id = group.id;
  titleInput.hidden = true;

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "icon-button";
  editButton.dataset.action = "rename-inline";
  editButton.dataset.id = group.id;
  editButton.setAttribute("aria-label", "Rename group");
  const editIcon = document.createElement("img");
  editIcon.src = "icons/pencil.svg";
  editIcon.alt = "";
  editIcon.setAttribute("aria-hidden", "true");
  editIcon.className = "icon";

  editButton.append(editIcon);

  titleWrap.append(title, titleInput, editButton);

  const badges = document.createElement("div");
  badges.className = "badges";

  if (isDefault) {
    badges.append(createBadge("Default"));
  }

  header.append(titleWrap, badges);

  const meta = document.createElement("p");
  meta.className = "group-meta";
  meta.textContent = `${formatCount(group.items.length)} · Updated ${formatDate(group.updatedAt)}`;

  const actions = document.createElement("div");
  actions.className = "group-actions";

  const setDefaultButton = document.createElement("button");
  setDefaultButton.type = "button";
  setDefaultButton.setAttribute("aria-label", "Set default");
  setDefaultButton.title = "Set default";
  setDefaultButton.dataset.action = "set-default";
  setDefaultButton.dataset.id = group.id;
  setDefaultButton.disabled = isDefault;
  setDefaultButton.className = "icon-button";
  const setDefaultIcon = document.createElement("img");
  setDefaultIcon.src = "icons/star.svg";
  setDefaultIcon.alt = "";
  setDefaultIcon.setAttribute("aria-hidden", "true");
  setDefaultIcon.className = "icon";
  setDefaultButton.append(setDefaultIcon);

  const setActiveButton = document.createElement("button");
  setActiveButton.type = "button";
  setActiveButton.setAttribute("aria-label", "Switch");
  setActiveButton.title = "Switch";
  setActiveButton.dataset.action = "set-active";
  setActiveButton.dataset.id = group.id;
  setActiveButton.className = "icon-button primary";
  const setActiveIcon = document.createElement("img");
  setActiveIcon.src = "icons/arrow-left-right.svg";
  setActiveIcon.alt = "";
  setActiveIcon.setAttribute("aria-hidden", "true");
  setActiveIcon.className = "icon";
  setActiveButton.append(setActiveIcon);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", "Delete");
  deleteButton.title = "Delete";
  deleteButton.dataset.action = "delete";
  deleteButton.dataset.id = group.id;
  deleteButton.className = "icon-button danger";
  const deleteIcon = document.createElement("img");
  deleteIcon.src = "icons/trash-2.svg";
  deleteIcon.alt = "";
  deleteIcon.setAttribute("aria-hidden", "true");
  deleteIcon.className = "icon";
  deleteButton.append(deleteIcon);

  if (isMapped) {
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.setAttribute("aria-label", "Refresh pins");
    refreshButton.title = "Refresh pins";
    refreshButton.dataset.action = "refresh";
    refreshButton.dataset.id = group.id;
    refreshButton.className = "icon-button secondary";
    const refreshIcon = document.createElement("img");
    refreshIcon.src = "icons/rotate-cw.svg";
    refreshIcon.alt = "";
    refreshIcon.setAttribute("aria-hidden", "true");
    refreshIcon.className = "icon";
    refreshButton.append(refreshIcon);
    actions.append(refreshButton);
  }

  if (!isMapped) {
    actions.append(setActiveButton);
  }
  actions.append(setDefaultButton, deleteButton);
  card.append(header, actions, meta);

  return card;
}

async function getPinnedItemsFromCurrentWindow(options: { refreshSnapshots?: boolean } = {}): Promise<PinnedItemInput[]> {
  const [tabs, snapshots] = await Promise.all([
    new Promise<TabInfo[]>((resolve) => {
      chrome.tabs.query({ currentWindow: true, pinned: true }, (result: TabInfo[]) => resolve(result));
    }),
    getPinnedSnapshots(),
  ]);

  const items: PinnedItemInput[] = [];
  let changed = false;

  for (const tab of tabs) {
    const key = typeof tab.id === "number" ? String(tab.id) : undefined;
    const stored = key ? snapshots[key] : undefined;
    const shouldRefresh = Boolean(options.refreshSnapshots);
    if (stored && !shouldRefresh) {
      items.push(stored);
      continue;
    }
    const snapshot = tabToSnapshot(tab, stored?.id);
    if (!snapshot) continue;
    const nextSnapshot = snapshot.id ? snapshot : { ...snapshot, id: generateId() };
    items.push(nextSnapshot);
    if (key) {
      snapshots[key] = nextSnapshot;
      changed = true;
    }
  }

  if (changed) {
    await setPinnedSnapshots(snapshots);
  }

  return dedupeItems(items);
}

async function syncGroupFromPinnedTabs(
  groupId: string,
  options: { refreshSnapshots?: boolean } = {}
): Promise<void> {
  const snapshots = await getPinnedItemsFromCurrentWindow(options);
  const items = snapshots.map((item) => snapshotToPinnedItem(item, groupId));
  const state = await ensureDefaultGroup();
  const target = state.groups.find((group) => group.id === groupId);
  if (!target) return;

  const same =
    target.items.length === items.length &&
    target.items.every((item, index) => {
      const candidate = items[index];
      return item.id === candidate?.id && item.url === candidate?.url && item.title === candidate?.title;
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

  const snapshots = await getPinnedItemsFromCurrentWindow();

  if (snapshots.length === 0) {
    setStatus("No pinned tabs found in this window.", "error");
    saveButtonEl.disabled = false;
    return;
  }

  const state = await ensureDefaultGroup();
  const now = Date.now();
  const newGroupId = generateId();
  const items = snapshots.map((item) => snapshotToPinnedItem(item, newGroupId));

  const newGroup: PinnedGroup = {
    id: newGroupId,
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

  await setActiveGroupId(newGroup.id);
  const windowId = await new Promise<number | undefined>((resolve) => {
    chrome.windows.getCurrent({}, (window: WindowInfo) => resolve(window?.id));
  });
  if (typeof windowId === "number") {
    await setWindowGroupId(windowId, newGroup.id);
  }

  groupNameInputEl.value = "";
  setStatus("Group saved and syncing here.");
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

  let nextDefaultId = state.defaultGroupId === groupId ? undefined : state.defaultGroupId;
  if (!nextDefaultId && nextGroups.length > 0) {
    const sorted = sortGroups({ ...state, groups: nextGroups, defaultGroupId: undefined });
    nextDefaultId = sorted[0]?.id;
  }

  const nextState: SyncStateV1 = {
    ...state,
    groups: nextGroups,
    defaultGroupId: nextDefaultId,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();
  if (localState.activeGroupId === groupId) {
    await setActiveGroupId(undefined);
  }
  chrome.runtime.sendMessage({
    type: "pinstack:group-deleted",
    groupId,
  });
  setStatus("Group deleted.");
  await renderGroups();
}

async function renameGroup(groupId: string, nextName: string): Promise<void> {
  const state = await ensureDefaultGroup();
  const target = state.groups.find((group) => group.id === groupId);
  if (!target) return;
  const trimmed = nextName.trim();
  if (!trimmed || trimmed === target.name) return;
  const nextGroups = state.groups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          name: trimmed,
          updatedAt: Date.now(),
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
  setStatus("Group renamed.");
  await renderGroups();
}

async function setActiveGroup(groupId: string): Promise<void> {
  const state = await ensureDefaultGroup();
  if (!state.groups.some((group) => group.id === groupId)) return;

  const windowId = await new Promise<number | undefined>((resolve) => {
    chrome.windows.getCurrent({}, (window: WindowInfo) => resolve(window?.id));
  });
  if (typeof windowId !== "number") return;
  const result = await new Promise<{ ok?: boolean }>((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "pinstack:apply-group",
        windowId,
        groupId,
      },
      (response: { ok?: boolean } | undefined) => resolve(response ?? {})
    );
  });
  if (!result.ok) {
    setStatus("Failed to switch group.", "error");
    return;
  }
  setStatus("Switched to group.");
  await renderGroups();
}

async function refreshPinnedTabs(groupId: string): Promise<void> {
  setStatus("Refreshing pinned tabs…");
  const windowId = await new Promise<number | undefined>((resolve) => {
    chrome.windows.getCurrent({}, (window: WindowInfo) => resolve(window?.id));
  });
  if (typeof windowId !== "number") {
    setStatus("Failed to refresh pins.", "error");
    return;
  }
  const result = await new Promise<{ ok?: boolean }>((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "pinstack:refresh-group",
        windowId,
        groupId,
      },
      (response: { ok?: boolean } | undefined) => resolve(response ?? {})
    );
  });
  if (!result.ok) {
    setStatus("Failed to refresh pins.", "error");
    return;
  }
  await renderGroups();
  setStatus("Pinned tabs refreshed.");
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

  if (target.dataset.action === "rename-inline") {
    const card = target.closest<HTMLElement>(".group-card");
    if (!card) return;
    const title = card.querySelector<HTMLElement>(".group-title-text");
    const input = card.querySelector<HTMLInputElement>(".group-title-input");
    const button = card.querySelector<HTMLElement>(".icon-button");
    if (!title || !input || !button) return;
    title.hidden = true;
    button.hidden = true;
    input.hidden = false;
    input.value = input.value || title.textContent || "";
    input.focus();
    input.select();
  }

  if (target.dataset.action === "refresh") {
    void refreshPinnedTabs(target.dataset.id);
  }
});

groupsListEl.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.classList.contains("group-title-input")) return;
  const card = target.closest<HTMLElement>(".group-card");
  const title = card?.querySelector<HTMLElement>(".group-title-text");
  const button = card?.querySelector<HTMLElement>(".icon-button");
  if (!card || !title || !button) return;

  if (event.key === "Escape") {
    event.preventDefault();
    target.hidden = true;
    title.hidden = false;
    button.hidden = false;
    target.value = title.textContent ?? "";
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const groupId = target.dataset.id;
    if (groupId) {
      void renameGroup(groupId, target.value);
    }
    target.hidden = true;
    title.hidden = false;
    button.hidden = false;
  }
});

groupsListEl.addEventListener("focusout", (event) => {
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.classList.contains("group-title-input")) return;
  const card = target.closest<HTMLElement>(".group-card");
  const title = card?.querySelector<HTMLElement>(".group-title-text");
  const button = card?.querySelector<HTMLElement>(".icon-button");
  if (!card || !title || !button) return;
  const groupId = target.dataset.id;
  if (groupId) {
    void renameGroup(groupId, target.value);
  }
  target.hidden = true;
  title.hidden = false;
  button.hidden = false;
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
