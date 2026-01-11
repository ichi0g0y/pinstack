# Pinstack
Save and restore pinned tab groups across your devices using Chrome sync.

## Overview
Pinstack is a Chrome extension that lets you create named groups of your currently pinned tabs, store them using Chrome `storage.sync`, and automatically restore a default group whenever you open a new window. It is designed to help you start every browsing session with the tabs you need, no matter which computer you are using.

### Features
- Create a group from your current pinned tabs and give it a name.
- Set one group as the default to auto-populate new windows with those pinned tabs.
- Sync all your groups between devices through Chrome sync.
- Manage your groups via a popup: set default, delete, and create new groups.
- See a notice when new synced data arrives from another device.

### How it works
When you save your current pinned tabs, Pinstack collects their URLs and stores them in a named group. This data is saved to Chrome synchronized storage so it follows you to any device you sign in with. When a new window opens and it contains only a blank tab, the extension checks your default group and opens each URL as a pinned tab at the left side of the tab bar.

## Local development
### Build
TypeScript sources live in `src/` and compile to JavaScript in-place.

```bash
npm install
npm run build
```

### Install in Chrome
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `src/` directory.

## Permissions
- `tabs`: required to read pinned tabs and recreate them in new windows.
- `storage`: required to persist groups and sync them across devices using `chrome.storage.sync`.
