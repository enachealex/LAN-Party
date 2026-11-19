const { contextBridge, ipcRenderer } = require('electron')

// The message pop-up window (notify.html) and nothing more: it is handed cards to show, and it can
// say what was done with one (opened, replied to, dismissed) and how tall its stack is.
contextBridge.exposeInMainWorld('notify', {
  onCard: (cb) => ipcRenderer.on('notify:card', (_e, card) => cb(card)),
  onReplyResult: (cb) => ipcRenderer.on('notify:reply-result', (_e, result) => cb(result)),
  open: (id) => ipcRenderer.send('notify:open', id),
  reply: (id, text) => ipcRenderer.send('notify:reply', { id, text }),
  dismiss: (id) => ipcRenderer.send('notify:dismiss', id),
  wantFocus: () => ipcRenderer.send('notify:focus'),
  size: (height) => ipcRenderer.send('notify:size', height),
})
