const { contextBridge } = require('electron')

// Minimal, safe bridge. Lets the web client detect it's running inside the desktop app
// (contextIsolation is on, so nothing else from Node is exposed to the renderer).
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
})
