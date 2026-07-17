const { contextBridge, ipcRenderer } = require('electron')

// Bridge for the transparent video-overlay window. It runs its own WebRTC peer, receives the call
// video from the main renderer (relayed through the main process), and answers back.
contextBridge.exposeInMainWorld('overlayBridge', {
  onSignal: (cb) => ipcRenderer.on('overlay:signal', (_e, msg) => cb(msg)),
  send: (msg) => ipcRenderer.send('overlay:to-main', msg),
  restore: () => ipcRenderer.send('overlay:restore'),
  close: () => ipcRenderer.send('overlay:close'),
  resizeBy: (dw, dh) => ipcRenderer.send('overlay:resize', { dw, dh }),
})
