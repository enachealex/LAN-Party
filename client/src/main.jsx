import { createRoot } from 'react-dom/client'
import App from './App'
import CallOverlay from './CallOverlay'
import './styles.css'

// The transparent Electron video overlay loads this same SPA with ?overlay=1 (loading a standalone
// overlay.html into a second window fails with ERR_FAILED, but the SPA loads fine). In that mode we
// render only the tiny overlay UI — no app boot, no sockets, no service worker.
const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1'

if (isOverlay) {
  document.documentElement.classList.add('overlay-mode')
  document.body.classList.add('overlay-mode')
  createRoot(document.getElementById('root')).render(<CallOverlay />)
} else {
  // NOTE: StrictMode is intentionally omitted. Its dev-only double-invoke of effects broke the
  // Giphy <Grid> initial fetch (@giphy/react-components + React 18) and caused a duplicate socket
  // connection (double-firing soundboard plays). Production behavior is unchanged either way.
  createRoot(document.getElementById('root')).render(<App />)

  // Register service worker for PWA support — under the app's base path (e.g. /app/) so the
  // scope matches wherever the app is mounted.
  if ('serviceWorker' in navigator) {
    const base = import.meta.env.BASE_URL || '/'
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(base + 'service-worker.js', { scope: base }).then(() => {
        console.log('Service worker registered')
      }).catch(err => console.warn('Service worker failed', err))
    })
  }
}
