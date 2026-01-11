# Pinstack  
Save and restore pinned tab groups across your devices using Chrome sync.  

## Overview  
Pinstack is a Chrome extension that lets you create named groups of your currently pinned tabs, store them using Chrome’s `storage.sync`, and automatically restore a default group whenever you open a new window. It’s designed to help you start every browsing session with the tabs you need, no matter which computer you’re using.  

### Features  
- Create a group from your current pinned tabs and give it a name.  
- Set one group as the default to auto‑populate new windows with those pinned tabs.  
- Sync all your groups between devices through Chrome’s sync service.  
- Manage your groups via a simple popup: set default, delete, and create new groups.  

### How it works  
When you press the button to save your current pinned tabs, Pinstack collects the URLs of those tabs and stores them in a named group. This information is saved to Chrome’s synchronized storage so it follows you to any device you sign in with. When a new window is opened and it contains only a blank tab, the extension checks your default group and opens each URL as a pinned tab at the left side of the tab bar. 
