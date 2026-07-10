const { app, BrowserWindow, session, desktopCapturer } = require('electron')
const path = require('path')
const url = require('url')

let mainWindow

// Where to load the client from:
//   dev  -> ELECTRON_START_URL (the Vite dev server, e.g. http://localhost:5173)
//   prod -> the built client bundle (packaged under resources, or client/dist when unpackaged)
function getStartUrl() {
  if (process.env.ELECTRON_START_URL) return process.env.ELECTRON_START_URL
  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, 'client-dist', 'index.html')
    : path.join(__dirname, '..', 'client', 'dist', 'index.html')
  return url.pathToFileURL(indexPath).toString()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadURL(getStartUrl())
  mainWindow.on('closed', () => { mainWindow = null })
}

// Grant camera / microphone / screen-capture to this first-party app, and provide a source
// for getDisplayMedia so screen sharing (Task 4) works in the desktop build.
function configureMedia() {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(permission))
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

app.whenReady().then(() => {
  configureMedia()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
