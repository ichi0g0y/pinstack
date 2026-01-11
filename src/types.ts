export type PinnedItem = { url: string; title?: string };

export type PinnedGroup = {
  id: string;
  name: string;
  items: PinnedItem[];
  createdAt: number;
  updatedAt: number;
};

export type SyncStateV1 = {
  version: 1;
  groups: PinnedGroup[];
  defaultGroupId?: string;
};

export type LocalStateV1 = {
  version: 1;
  lastLocalWriteAt: number;
  hasRemoteUpdate: boolean;
  activeGroupId?: string;
};
