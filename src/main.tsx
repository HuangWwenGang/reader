import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Note: intentionally not using React.StrictMode — it double-invokes effects in
// dev, which would open the foliate-view twice. Single-user app, fine to skip.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
