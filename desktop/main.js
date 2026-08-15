const { app, BrowserWindow, session, desktopCapturer, shell, dialog, Notification, Tray, Menu, nativeImage, ipcMain } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

// The desktop app is a thin native shell around the LIVE hosted web app. Because it loads the same
// origin the browser + PWA use, conversations and chats are always in sync — nothing is stored on
// this device; the server is the single source of truth. Override for local dev with LANPARTY_URL.
const APP_URL = process.env.LANPARTY_URL || 'https://lanparty.thejumpvault.com/app/'
const APP_ORIGIN = new URL(APP_URL).origin

let mainWindow
let tray = null
let isQuitting = false
let trayTipShown = false

// Hide the window into the system tray (the "taskbar drawer") instead of quitting, so the app keeps
// running in the background — voice/video calls and chat stay connected while it's hidden.
let overlayWindow = null

function hideToTray() {
  if (!mainWindow) return
  mainWindow.hide()
  if (process.platform === 'win32') mainWindow.setSkipTaskbar(true)
  mainWindow.webContents.send('app:visibility', false) // let the renderer pop video to the overlay
  if (!trayTipShown && Notification.isSupported()) {
    trayTipShown = true
    new Notification({ title: 'LAN Party is still running', body: 'It lives in your tray now — calls and chat keep working. Right-click the tray icon to quit.' }).show()
  }
}

// Bring the window back from ANY hidden state. Order matters: a hidden window can't be focused into
// view, and a minimized one needs restore() first — so show() + restore() both run before focus().
function showFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (process.platform === 'win32') mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send('app:visibility', true) // renderer tears the overlay down
}

// A frameless, transparent, always-on-top window that shows a call's remote video while the main
// window is hidden — so you can still see others (75% transparent) and drag/resize it out of the way.
function createOverlayWindow() {
  if (overlayWindow) return overlayWindow
  overlayWindow = new BrowserWindow({
    width: 360, height: 232, minWidth: 200, minHeight: 130,
    frame: false, transparent: true, resizable: true, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: false, show: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true)
  // Load the SPA with ?overlay=1 (it renders only the overlay UI). A standalone overlay.html fails to
  // load in a second window with ERR_FAILED, but the SPA route loads fine; the overlay-preload still
  // provides the overlayBridge IPC.
  overlayWindow.loadURL(new URL('?overlay=1', APP_URL).toString())
    .catch((e) => console.error('[overlay] load failed', e && e.message))
  overlayWindow.on('closed', () => { overlayWindow = null })
  return overlayWindow
}

// --- Overlay IPC: relay WebRTC signaling between the main renderer and the overlay renderer ---
ipcMain.on('overlay:show', () => { createOverlayWindow().show() })
ipcMain.on('overlay:hide', () => { if (overlayWindow) overlayWindow.hide() })
ipcMain.on('overlay:close', () => { if (overlayWindow) { overlayWindow.close(); overlayWindow = null } })
ipcMain.on('overlay:to-overlay', (_e, msg) => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('overlay:signal', msg) })
ipcMain.on('overlay:to-main', (_e, msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('overlay:signal', msg) })
ipcMain.on('overlay:restore', () => { showFromTray() }) // overlay "expand" button → bring the app back
ipcMain.on('overlay:resize', (_e, { dw, dh } = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const [w, h] = overlayWindow.getSize()
  overlayWindow.setSize(Math.max(200, Math.round(w + (dw || 0))), Math.max(130, Math.round(h + (dh || 0))))
})

function createTray() {
  if (tray) return
  // If the tray can't be created there is no way back from a hidden window, so failure is recorded
  // (tray stays null) and the close handler then lets the window close normally instead of trapping
  // the app in an invisible state.
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'))
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 })
    tray = new Tray(img)
    tray.setToolTip('LAN Party — click to reopen')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show LAN Party', click: showFromTray },
      { type: 'separator' },
      { label: 'Quit LAN Party', click: () => { isQuitting = true; app.quit() } },
    ]))
    tray.on('click', showFromTray)
    tray.on('double-click', showFromTray)
  } catch (err) {
    tray = null
    console.error('[tray] could not create tray icon; closing will quit instead of hiding:', err && err.message)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: 'LAN Party',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers + requestAnimationFrame running at full rate when the window is hidden/minimized
      // to the tray, so a shared camera (which flows through a canvas.captureStream) never freezes
      // and calls keep working in the background.
      backgroundThrottling: false,
    },
  })

  mainWindow.loadURL(APP_URL)
  mainWindow.on('closed', () => { mainWindow = null })

  // Closing the window hides it to the tray (keeps calls/chat alive) instead of quitting. Without a
  // tray icon there'd be no way to get the window back, so in that case let the close proceed.
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) { e.preventDefault(); hideToTray() }
  })

  // Keep app + OAuth flows inside the window; send everything else (links people paste in chat,
  // "watch on Twitch/YouTube", etc.) to the user's real browser.
  const AUTH_HOSTS = ['accounts.spotify.com', 'accounts.google.com']
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url)
      if (u.origin === APP_ORIGIN || AUTH_HOSTS.includes(u.hostname)) return { action: 'allow' }
    } catch (_) { /* fall through to external */ }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Grant camera / microphone / screen-capture to this first-party app, and provide a source for
// getDisplayMedia so screen sharing works in the desktop build.
function configureMedia() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications'].includes(permission))
  })
  ses.setPermissionCheckHandler(() => true)
  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] })
        .then((sources) => callback(sources.length ? { video: sources[0] } : {}))
        .catch(() => callback({}))
    }, { useSystemPicker: true }) // OS picker on supported platforms; falls back to first source
  }
}

// Check for a new shell version at startup (and periodically), download it in the background, and
// install it. Because chats live on the server, updating the shell never touches conversation data
// — the app just reloads the live web app after restarting and everything is already in sync.
// Tell the renderer where the update check is up to, so the startup splash isn't guessing. Safe to
// call before the window exists or after it's gone.
function sendUpdateStatus(status) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update-status', status)
  } catch (_) { /* window torn down mid-check */ }
}

function setupAutoUpdates() {
  // Unpackaged dev runs have no feed, but the renderer still waits on a status — answer immediately
  // instead of letting the splash sit on this step until its timeout.
  if (!app.isPackaged) { sendUpdateStatus('none'); return }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('none'))
  autoUpdater.on('download-progress', () => sendUpdateStatus('downloading'))

  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available')
    if (Notification.isSupported()) {
      new Notification({ title: 'LAN Party', body: `Downloading update v${info.version}…` }).show()
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatus('downloaded')
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `LAN Party ${info.version} is ready to install.`,
      detail: 'Restart to apply it. Your conversations stay in sync — nothing is stored on this device, so no messages are lost.',
    })
    if (choice === 0) autoUpdater.quitAndInstall()
    // If "Later": autoInstallOnAppQuit applies the update the next time the app closes.
  })

  autoUpdater.on('error', (err) => {
    sendUpdateStatus('error')
    console.error('auto-update error:', err == null ? 'unknown' : (err.stack || err).toString())
  })

  autoUpdater.checkForUpdates().catch(() => {})
  // Re-check every 6 hours for long-running sessions.
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 6 * 60 * 60 * 1000)
}

// Single-instance: focus the existing window instead of opening a second copy.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Relaunching from the shortcut/taskbar while we're hidden in the tray must bring the app BACK —
  // this is how most people "reopen" it, and focus() alone can't reveal a hidden window, which made
  // the app look like it had quit.
  app.on('second-instance', () => { showFromTray() })

  app.whenReady().then(() => {
    configureMedia()
    createWindow()
    createTray()
    setupAutoUpdates()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showFromTray()
    })
  })

  // Mark a real quit (tray "Quit", auto-update restart, OS shutdown) so the close handler lets it through.
  app.on('before-quit', () => { isQuitting = true })

  // Do NOT quit when the window is closed — the app lives in the tray and keeps running so the user
  // stays in their call. Quitting happens only via the tray menu / auto-update / before-quit.
  // Exception: with no tray icon there's nothing left to interact with, so don't linger as a
  // process the user can't see or reach.
  app.on('window-all-closed', () => { if (!tray) app.quit() })
}
