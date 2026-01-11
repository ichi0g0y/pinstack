import { generateId, getLocalState, getSyncState, markLocalWrite, setSyncState, updateLocalState } from "./storage.js";
import type { PinnedGroup, SyncStateV1 } from "./types.js";

type TabInfo = { url?: string; pendingUrl?: string; title?: string };

const groupNameInput = document.querySelector<HTMLInputElement>("#groupName");
const saveButton = document.querySelector<HTMLButtonElement>("#saveGroup");
const groupsList = document.querySelector<HTMLDivElement>("#groupsList");
const emptyState = document.querySelector<HTMLParagraphElement>("#emptyState");
const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const syncNotice = document.querySelector<HTMLDivElement>("#syncNotice");

if (!groupNameInput || !saveButton || !groupsList || !emptyState || !statusEl || !syncNotice) {
  throw new Error("Popup UI is missing required elements.");
}

const groupNameInputEl = groupNameInput;
const saveButtonEl = saveButton;
const groupsListEl = groupsList;
const emptyStateEl = emptyState;
const statusElEl = statusEl;
const syncNoticeEl = syncNotice;

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

async function renderGroups(): Promise<void> {
  const state = await getSyncState();
  const groups = [...state.groups].sort((a, b) => b.createdAt - a.createdAt);

  groupsListEl.innerHTML = "";
  if (groups.length === 0) {
    emptyStateEl.hidden = false;
    return;
  }

  emptyStateEl.hidden = true;
  groups.forEach((group) => {
    const isDefault = group.id === state.defaultGroupId;
    groupsListEl.appendChild(createGroupCard(group, isDefault));
  });
}

function createGroupCard(group: PinnedGroup, isDefault: boolean): HTMLElement {
  const card = document.createElement("article");
  card.className = "group-card";

  const header = document.createElement("div");
  header.className = "group-header";

  const title = document.createElement("h3");
  title.textContent = group.name;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = isDefault ? "Default" : "Saved";

  header.append(title, badge);

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

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.dataset.action = "delete";
  deleteButton.dataset.id = group.id;
  deleteButton.className = "danger";

  actions.append(setDefaultButton, deleteButton);
  card.append(header, meta, actions);

  return card;
}

async function saveGroupFromPinnedTabs(): Promise<void> {
  const name = groupNameInputEl.value.trim();
  if (!name) {
    setStatus("Please enter a group name.", "error");
    return;
  }

  saveButtonEl.disabled = true;
  setStatus("Capturing pinned tabs…");

  const tabs = await new Promise<TabInfo[]>((resolve) => {
    chrome.tabs.query({ currentWindow: true, pinned: true }, (result: TabInfo[]) => resolve(result));
  });

  const items = tabs
    .map((tab) => {
      const url = tab.url ?? tab.pendingUrl ?? "";
      if (!url || url === "about:blank" || url.startsWith("chrome://newtab")) return null;
      const item = { url } as { url: string; title?: string };
      if (tab.title) item.title = tab.title;
      return item;
    })
    .filter((item): item is { url: string; title?: string } => Boolean(item));

  if (items.length === 0) {
    setStatus("No pinned tabs found in this window.", "error");
    saveButtonEl.disabled = false;
    return;
  }

  const state = await getSyncState();
  const now = Date.now();

  const newGroup: PinnedGroup = {
    id: generateId(),
    name,
    items,
    createdAt: now,
    updatedAt: now,
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
  const state = await getSyncState();
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
  const state = await getSyncState();
  const nextGroups = state.groups.filter((group) => group.id !== groupId);

  const nextState: SyncStateV1 = {
    ...state,
    groups: nextGroups,
    defaultGroupId: state.defaultGroupId === groupId ? undefined : state.defaultGroupId,
  };

  await markLocalWrite();
  await setSyncState(nextState);
  await clearRemoteNotice();
  setStatus("Group deleted.");
  await renderGroups();
}

groupsListEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!target.dataset.action || !target.dataset.id) return;

  if (target.dataset.action === "set-default") {
    void setDefaultGroup(target.dataset.id);
  }

  if (target.dataset.action === "delete") {
    void deleteGroup(target.dataset.id);
  }
});

saveButtonEl.addEventListener("click", () => {
  void saveGroupFromPinnedTabs();
});

groupNameInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveGroupFromPinnedTabs();
  }
});

void (async () => {
  await refreshSyncNotice();
  await renderGroups();
})();
