const { contextBridge, ipcRenderer } = require('electron')

// Minimal, safe bridge. Lets the web client detect it's running inside the desktop app
// (contextIsolation is on, so nothing else from Node is exposed to the renderer).
contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  platform: process.platform,
  // Window hidden/shown to the tray → the client pops the call video into the floating overlay.
  onVisibility: (cb) => ipcRenderer.on('app:visibility', (_e, visible) => cb(visible)),
  // Show / hide / close the transparent always-on-top video overlay.
  overlayShow: () => ipcRenderer.send('overlay:show'),
  overlayHide: () => ipcRenderer.send('overlay:hide'),
  overlayClose: () => ipcRenderer.send('overlay:close'),
  // Relay WebRTC signaling to the overlay window, and receive answers/candidates back.
  overlaySend: (msg) => ipcRenderer.send('overlay:to-overlay', msg),
  onOverlaySignal: (cb) => ipcRenderer.on('overlay:signal', (_e, msg) => cb(msg)),
})
