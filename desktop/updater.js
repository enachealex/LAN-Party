// The startup updater window: shows what main.js reports and sends back the user's choice.
//   checking     "Checking for updates…" (moving bar)
//   available    "Version X is available" + Download & install / Later
//   downloading  progress bar with percent and size
//   installing   "Installing…" (the app restarts by itself)
//   error        what went wrong + Continue (opens LAN Party anyway)
//   starting     "Starting LAN Party…" (no update, or the user chose Later)
const status = document.getElementById('status')
const bar = document.getElementById('bar')
const fill = bar.firstElementChild
const buttons = document.getElementById('buttons')
const primary = document.getElementById('primary')
const secondary = document.getElementById('secondary')
const version = document.getElementById('version')

let primaryChoice = null
let secondaryChoice = null
primary.addEventListener('click', () => { if (primaryChoice) { buttons.style.visibility = 'hidden'; window.updater.choose(primaryChoice) } })
secondary.addEventListener('click', () => { if (secondaryChoice) { buttons.style.visibility = 'hidden'; window.updater.choose(secondaryChoice) } })

const mb = (bytes) => (bytes / 1048576).toFixed(1)

function show({ text, barMode = 'hidden', percent = 0, primaryLabel = null, primaryAction = null, secondaryLabel = null, secondaryAction = null }) {
  status.textContent = text
  bar.style.visibility = barMode === 'hidden' ? 'hidden' : 'visible'
  bar.classList.toggle('indeterminate', barMode === 'indeterminate')
  fill.style.width = barMode === 'progress' ? `${Math.max(0, Math.min(100, percent))}%` : ''
  primaryChoice = primaryAction
  secondaryChoice = secondaryAction
  primary.textContent = primaryLabel || ''
  secondary.textContent = secondaryLabel || ''
  primary.style.display = primaryLabel ? '' : 'none'
  secondary.style.display = secondaryLabel ? '' : 'none'
  buttons.style.visibility = primaryLabel || secondaryLabel ? 'visible' : 'hidden'
  if (primaryLabel) primary.focus()
}

window.updater.onState((s) => {
  if (s.current) version.textContent = `Version ${s.current}`
  switch (s.kind) {
    case 'checking':
      show({ text: 'Checking for updates…', barMode: 'indeterminate' }); break
    case 'available':
      show({ text: `LAN Party ${s.version} is available.`, primaryLabel: 'Download & install', primaryAction: 'install', secondaryLabel: 'Later', secondaryAction: 'later' }); break
    case 'downloading': {
      const size = s.total ? ` (${mb(s.transferred || 0)} of ${mb(s.total)} MB)` : ''
      show({ text: `Downloading update… ${Math.round(s.percent || 0)}%${size}`, barMode: 'progress', percent: s.percent || 0 }); break
    }
    case 'installing':
      show({ text: 'Installing the update. LAN Party will restart by itself.', barMode: 'indeterminate' }); break
    case 'error':
      show({ text: s.message || 'The update could not be downloaded.', primaryLabel: 'Continue', primaryAction: 'continue', secondaryLabel: 'Try again', secondaryAction: 'install' }); break
    case 'starting':
    default:
      show({ text: 'Starting LAN Party…', barMode: 'indeterminate' }); break
  }
})
