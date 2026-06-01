import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Note: intentionally not using React.StrictMode — it double-invokes effects in
// dev, which would open the foliate-view twice. Single-user app, fine to skip.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

// Nudge the service worker to check for a new version on focus and periodically.
// vite-plugin-pwa (autoUpdate) will skipWaiting + reload when one is found. This
// fights iOS's tendency to keep serving a stale cached build.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready
    .then((reg) => {
      const check = () => reg.update().catch(() => {})
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.setInterval(check, 60_000)
    })
    .catch(() => {})
}
