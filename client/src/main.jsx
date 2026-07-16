import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

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
