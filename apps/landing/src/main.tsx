import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'lenis/dist/lenis.css'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')!

if (root.hasChildNodes()) {
  document.head.querySelectorAll('[data-rh="true"]').forEach((node) => node.remove())
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
