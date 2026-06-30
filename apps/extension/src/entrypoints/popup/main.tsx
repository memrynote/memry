import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyStoredTheme } from '@/components/ThemeToggle'
import './tokens.css'

applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
