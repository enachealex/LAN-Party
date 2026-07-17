const { app, BrowserWindow, session, desktopCapturer, shell, dialog, Notification } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

// The desktop app is a thin native shell around the LIVE hosted web app. Because it loads the same
// origin the browser + PWA use, conversations and chats are always in sync — nothing is stored on
// this device; the server is the single source of truth. Override for local dev with LANPARTY_URL.
const APP_URL = process.env.LANPARTY_URL || 'https://lanparty.thejumpvault.com/app/'
const APP_ORIGIN = new URL(APP_URL).origin

let mainWindow

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
    },
  })

  mainWindow.loadURL(APP_URL)
  mainWindow.on('closed', () => { mainWindow = null })

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
function setupAutoUpdates() {
  if (!app.isPackaged) return // no update feed when run unpackaged (dev)

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'LAN Party', body: `Downloading update v${info.version}…` }).show()
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    configureMedia()
    createWindow()
    setupAutoUpdates()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
