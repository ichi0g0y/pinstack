export type PinnedItem = { id: string; url: string; title?: string; faviconUrl?: string };

export type PinnedSnapshot = { id?: string; url: string; title?: string; faviconUrl?: string };

export type PinnedGroup = {
  id: string;
  name: string;
  items: PinnedItem[];
  createdAt: number;
  updatedAt: number;
  order?: number;
};

export type SyncStateV1 = {
  version: 1;
  groups: PinnedGroup[];
};

export type LocalStateV1 = {
  version: 1;
  lastLocalWriteAt: number;
  hasRemoteUpdate: boolean;
  activeGroupId?: string;
  deviceDefaultGroupId?: string;
  autoApplyDefaultOnNewWindow?: boolean;
  closePinnedToSuspend?: boolean;
  windowGroupMap?: Record<string, string>;
  windowGroupLockMap?: Record<string, boolean>;
  unmanagedWindowMap?: Record<string, boolean>;
};

export type PreferenceStateV1 = {
  version: 1;
  closePinnedToSuspend: boolean;
};
