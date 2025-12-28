import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider } from 'next-themes'
import App from './App'
import QuickCapture from './components/quick-capture'

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

// Render appropriate component based on route
const RootComponent = isQuickCaptureWindow ? (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <QuickCapture />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
) : (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)

createRoot(document.getElementById('root')!).render(RootComponent)
