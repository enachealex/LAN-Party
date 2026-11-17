const { contextBridge, ipcRenderer } = require('electron')

// The startup updater window's only bridge: it is told what the update check is doing, and it can
// answer the one question it asks (install now, or later). Nothing else from Node is exposed.
contextBridge.exposeInMainWorld('updater', {
  onState: (cb) => ipcRenderer.on('updater:state', (_e, state) => cb(state)),
  choose: (choice) => ipcRenderer.send('updater:choice', choice),
})
