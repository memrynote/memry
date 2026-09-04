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
import {
  createRendererI18n,
  I18nProvider,
  applyLocaleToDocument,
  type I18nInstance
} from '@memry/i18n/renderer'
import { type Locale } from '@memry/i18n/shared'
import App from './App'
import { setActiveLocale } from './lib/active-locale'
import QuickCapture from './components/quick-capture'
import { CrdtPersistenceNotice } from './components/crdt-persistence-notice'
import { AuthProvider } from './contexts/auth-context'
import { SyncProvider } from './contexts/sync-context'
import { AISettingsProvider } from './contexts/ai-settings-context'
import { getStartupTheme, THEME_STORAGE_KEY } from './lib/startup-theme'
import { getStartupLocale } from './lib/startup-locale'
import { prefetchRestoredTabPage } from './lib/launch-restore'
import { APP_QUERY_DEFAULT_OPTIONS } from './lib/query-client-options'
import { createLogger } from './lib/logger'
import {
  registerRendererDiagnostics,
  trackRendererError,
  trackRendererLog,
  trackRendererReady
} from './lib/telemetry-diagnostics'

// Create a client with default options for the entire app
const queryClient = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })

const log = createLogger('RendererBoot')
const rendererStartedAt = performance.now()
registerRendererDiagnostics()

// Sanitize a stale or corrupted theme value in localStorage before next-themes
// reads it. A pre-existing bug elsewhere can write `[object Object]` here,
// which next-themes then passes to documentElement.classList.add() — DOMTokenList
// rejects the token (it contains a space) and the renderer crashes blank.
try {
  const cached = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (
    cached !== null &&
    cached !== 'light' &&
    cached !== 'dark' &&
    cached !== 'white' &&
    cached !== 'system'
  ) {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  }
} catch {
  // localStorage may be unavailable; ignore
}

// Check if this is the quick capture window (opened via global shortcut)
// Handle both '#/quick-capture' and '#quick-capture' formats
const isQuickCaptureWindow =
  window.location.hash === '#/quick-capture' || window.location.hash === '#quick-capture'
const startupTheme = getStartupTheme()
const startupLocale = getStartupLocale()

// Kicked off at module scope, before `boot()` even starts, so the restored
// tab's chunk download overlaps everything boot() awaits (i18n, vault open,
// tab restore) instead of queueing behind them. `prefetchRestoredTabPage`
// already reads localStorage synchronously and no-ops when there is nothing
// to restore, so a wrong guess costs one speculative chunk fetch. Skipped for
// the quick-capture window, which never renders a note tab and would just be
// paying for a chunk it never uses.
if (!isQuickCaptureWindow) prefetchRestoredTabPage()

// Started at module scope rather than inside boot(): the locale is already
// known, so there is nothing left for the 11 locale namespace chunks to wait
// for. This used to sit behind `await window.api.locale.get()`, an IPC
// round-trip that races vault open on the main process.
const i18nReady = createRendererI18n({ locale: startupLocale })

// `locale.get()` stays the authority. It is consulted after the first render,
// and only ever disagrees when the preload's cache went stale, in which case
// the session switches through the same path a settings change takes.
async function reconcileStartupLocale(i18n: I18nInstance): Promise<void> {
  const actual = await window.api.locale.get()
  if (actual === startupLocale) return

  log.warn('Startup locale disagreed with the main process', {
    assumed: startupLocale,
    actual
  })
  await i18n.changeLanguage(actual)
  applyLocaleToDocument(actual)
}

async function boot(): Promise<void> {
  const i18n = await i18nReady

  // Keep the module-scoped locale that pure Intl helpers read in sync. Hooked to
  // i18next itself rather than to each caller, so every changeLanguage path
  // (settings, onboarding, sync from another device) is covered.
  setActiveLocale(startupLocale)
  i18n.on('languageChanged', (locale) => {
    setActiveLocale(locale as Locale)
  })

  window.api.onLocaleChanged((locale) => {
    void (async () => {
      await i18n.changeLanguage(locale)
      applyLocaleToDocument(locale)
    })()
  })

  const rootComponent = isQuickCaptureWindow ? (
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider
            attribute="class"
            defaultTheme={startupTheme}
            enableSystem
            themes={['light', 'dark', 'white', 'system']}
            storageKey={THEME_STORAGE_KEY}
          >
            <AISettingsProvider>
              <QuickCapture />
            </AISettingsProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>
  ) : (
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SyncProvider>
              <App />
              {/* After <App />, so the Toaster it renders is already mounted. */}
              <CrdtPersistenceNotice />
            </SyncProvider>
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>
  )

  createRoot(document.getElementById('root')!).render(rootComponent)
  trackRendererReady(performance.now() - rendererStartedAt)

  void reconcileStartupLocale(i18n).catch((error) => {
    log.error('Startup locale reconcile failed', error)
  })
}

void boot().catch((error) => {
  log.error('Renderer boot failed', error)
  trackRendererError('boot_failed', error)
  trackRendererLog('error', 'boot_failed', 'RendererBoot')
})
