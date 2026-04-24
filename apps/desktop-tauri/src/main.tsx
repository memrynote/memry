import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AppPlaceholder } from './app-placeholder'
import './assets/main.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <AppPlaceholder />
  </StrictMode>
)
