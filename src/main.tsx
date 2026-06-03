import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Note: intentionally not using React.StrictMode — it double-invokes effects in
// dev, which would open the foliate-view twice. Single-user app, fine to skip.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)

// Keep the PWA from getting stuck on a stale cached build (a real problem in
// standalone mode on iOS). Two parts:
//   1) actively poll for a new service worker on focus + periodically;
//   2) when a new worker takes control, RELOAD so the open page swaps to the new
//      assets — autoUpdate's skipWaiting activates the worker, but an already-open
//      iOS PWA won't refresh its JS/CSS on its own.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // skip the very first install (no prior controller) to avoid a reload loop
    if (refreshing || !hadController) return
    refreshing = true
    window.location.reload()
  })
  navigator.serviceWorker.ready
    .then((reg) => {
      const check = () => reg.update().catch(() => {})
      check()
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.setInterval(check, 30_000)
    })
    .catch(() => {})
}
