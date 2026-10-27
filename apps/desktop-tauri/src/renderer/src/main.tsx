import '@fontsource-variable/crimson-pro'
import '@fontsource-variable/crimson-pro/wght-italic.css'
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
import {
  createRendererI18n,
  I18nProvider,
  applyLocaleToDocument,
  type I18nInstance
} from '@memry/i18n/renderer'
import { type Locale } from '@memry/i18n/shared'
import { setActiveLocale } from './lib/active-locale'
import { THEME_STORAGE_KEY } from './lib/startup-theme'
import { getStartupLocale } from './lib/startup-locale'
import { prefetchRestoredTabPage } from './lib/launch-restore'
import { APP_QUERY_DEFAULT_OPTIONS } from './lib/query-client-options'
import { createLogger } from './lib/logger'
import { installNotPortedShim } from './lib/not-ported'
import { installPortedApi } from './lib/ported-api'
import { applyStartupState } from './lib/startup'
import { commands } from '../../generated/bindings'
import {
  registerRendererDiagnostics,
  trackRendererError,
  trackRendererLog,
  trackRendererReady
} from './lib/telemetry-diagnostics'

// The shim goes first: it stands in for `window.api`, which every ported domain replaces.
// Step 43 (#3560) deletes it.
if (import.meta.env.VITE_MEMRY_DEV_API_PROXY === '1') installNotPortedShim()
installPortedApi()

// The WDIO frontend plugin exists only in the e2e build; Vite removes this branch from every
// other build, so a release bundle never contains it.
if (import.meta.env.VITE_MEMRY_E2E === '1') await import('@wdio/tauri-plugin')

// Before first paint: theme, color theme, platform, zoom cache and locale.
applyStartupState()

// Create a client with default options for the entire app
const queryClient = new QueryClient({ defaultOptions: APP_QUERY_DEFAULT_OPTIONS })

const log = createLogger('RendererBoot')
const rendererStartedAt = performance.now()
commands
  .appInfo()
  .then((info) => log.info('app info', info))
  .catch((error: unknown) => log.warn('app_info failed', error))
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

// Quick Capture, the sticky and the sticky's edge tab load the same entry with
// their own hash; both '#/route' and '#route' forms are accepted.
const windowRoute = window.location.hash.replace(/^#\/?/, '')
const isQuickCaptureWindow = windowRoute === 'quick-capture'
const isStickyWindow = windowRoute === 'sticky'
const isStickyTabWindow = windowRoute === 'sticky-tab'
const isSecondaryWindow = isQuickCaptureWindow || isStickyWindow || isStickyTabWindow
const startupLocale = getStartupLocale()

// The sticky windows are transparent; only their card and tab are painted.
if (isStickyWindow || isStickyTabWindow) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.overflow = 'hidden'
}

// Dynamic on purpose: the window kind is known from the hash before anything
// else loads, so each window evaluates only its own tree. The secondary
// windows never load App, and the main window never loads them.
// Started at module scope so the chunk fetch overlaps the i18n boot below.
const rootComponentReady: Promise<React.ComponentType> = isQuickCaptureWindow
  ? import('./quick-capture-root').then((module) => module.QuickCaptureRoot)
  : isStickyWindow
    ? import('./sticky-root').then((module) => module.StickyRoot)
    : isStickyTabWindow
      ? import('./sticky-tab-root').then((module) => module.StickyTabRoot)
      : import('./main-window-root').then((module) => module.MainWindowRoot)

// Kicked off at module scope, before `boot()` even starts, so the restored
// tab's chunk download overlaps everything boot() awaits (i18n, vault open,
// tab restore) instead of queueing behind them. `prefetchRestoredTabPage`
// already reads localStorage synchronously and no-ops when there is nothing
// to restore, so a wrong guess costs one speculative chunk fetch. Skipped for
// the secondary windows, which never render a note tab and would just be
// paying for a chunk they never use.
if (!isSecondaryWindow) prefetchRestoredTabPage()

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
  const [i18n, RootComponent] = await Promise.all([i18nReady, rootComponentReady])

  // Keep the module-scoped locale that pure Intl helpers read in sync. Hooked to
  // i18next itself rather than to each caller, so every changeLanguage path
  // (settings, onboarding, sync from another device) is covered.
  setActiveLocale(startupLocale)
  i18n.on('languageChanged', (locale) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every changeLanguage caller passes a supported Locale; i18next only types it as string
    setActiveLocale(locale as Locale)
  })

  window.api.onLocaleChanged((locale) => {
    void (async () => {
      await i18n.changeLanguage(locale)
      applyLocaleToDocument(locale)
    })()
  })

  const rootComponent = (
    <StrictMode>
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RootComponent />
        </QueryClientProvider>
      </I18nProvider>
    </StrictMode>
  )

  createRoot(document.getElementById('root')!).render(rootComponent)
  trackRendererReady(performance.now() - rendererStartedAt)

  void reconcileStartupLocale(i18n).catch((error: unknown) => {
    log.error('Startup locale reconcile failed', error)
  })
}

void boot().catch((error: unknown) => {
  log.error('Renderer boot failed', error)
  trackRendererError('boot_failed', error)
  trackRendererLog('error', 'boot_failed', 'RendererBoot')
})
