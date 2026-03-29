import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/crimson-pro/wght-italic.css'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/dm-sans/wght-italic.css'
import '@fontsource-variable/geist'
import '@fontsource-variable/inter'
import '@fontsource/gelasio'
import '@fontsource/gelasio/400-italic.css'
import '@fontsource/gelasio/700.css'
import '@fontsource/gelasio/700-italic.css'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/playfair-display'
import '@fontsource-variable/playfair-display/wght-italic.css'
import '@fontsource-variable/space-grotesk'

import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import App from './App'
import QuickCapture from './components/quick-capture'
import { AuthProvider } from './contexts/auth-context'
import { SyncProvider } from './contexts/sync-context'
import { getStartupTheme, THEME_STORAGE_KEY } from './lib/startup-theme'

// Create a client with default options for the entire app
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 30 seconds
      staleTime: 30 * 1000,
      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,
      // Retry failed requests once
      retry: 1,
      // Don't refetch on window focus for desktop app
      refetchOnWindowFocus: false
    }
  }
})

// Check if this is the quick capture window (opened via global shortcut)
// Handle both '#/quick-capture' and '#quick-capture' formats
const isQuickCaptureWindow =
  window.location.hash === '#/quick-capture' || window.location.hash === '#quick-capture'
const startupTheme = getStartupTheme()

// Render appropriate component based on route
const RootComponent = isQuickCaptureWindow ? (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme={startupTheme}
        enableSystem
        themes={['light', 'dark', 'white', 'system']}
        storageKey={THEME_STORAGE_KEY}
      >
        <QuickCapture />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
) : (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SyncProvider>
          <App />
        </SyncProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
)

createRoot(document.getElementById('root')!).render(RootComponent)
