const { contextBridge, ipcRenderer } = require('electron')

// Bridge for the screen-share picker (picker.html), and nothing else: fetch the current list of
// screens and windows, choose one, or cancel. The main process checks every message comes from the
// picker window and that a chosen id is one it actually listed.
contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id) => ipcRenderer.send('picker:choose', String(id)),
  cancel: () => ipcRenderer.send('picker:cancel'),
})
