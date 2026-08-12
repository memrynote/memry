import {
  app,
  shell,
  BrowserWindow,
  crashReporter,
  ipcMain,
  protocol,
  net,
  globalShortcut,
  clipboard,
  screen,
  session,
  nativeImage,
  Menu,
  MenuItem,
  dialog,
  type IpcMainEvent
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, normalize } from 'path'
import { homedir } from 'node:os'
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { lookup as mimeLookup } from 'mime-types'
import { config } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'
import { registerAllHandlers } from './ipc'
import { applyGlobalCaptureShortcut, setGlobalCaptureAppliedHandler } from './ipc/settings-handlers'
import {
  autoOpenLastVault,
  beginVaultShutdown,
  closeVault,
  getStatus as getVaultStatus,
  onVaultStatusChanged
} from './vault'
import { readPreferences } from './vault/vault-preferences'
import {
  getCurrentVaultPath,
  getStoredLocale,
  getVaults,
  getWindowBounds,
  setStoredLocale,
  setWindowBounds
} from './store'
import {
  createWindowBoundsPersister,
  resolveStartupBounds,
  type SavedWindowBounds
} from './window-bounds'
import { resolveOsLocale } from './startup-locale'
import { configureSessionPermissions } from './session-permissions'
import { startSnoozeScheduler, stopSnoozeScheduler, checkDueItemsOnStartup } from './inbox/snooze'
import { stopVoiceModel } from './inbox/voice-model'
import { stopImageProcessing } from './image-processing/bridge'
import { getEmbeddingWorkerPhase, stopEmbeddingModel } from './lib/embeddings'
import { startReminderScheduler, stopReminderScheduler } from './lib/reminders'
import { startInboxReviewScheduler, stopInboxReviewScheduler } from './inbox/review-scheduler'
import { disposeTelemetryRuntime, initializeTelemetryRuntime } from './telemetry/runtime'
import { getTelemetryAuthState, getTelemetrySyncState } from './telemetry/state'
import { getLogShip, installLogShip } from './telemetry/log-ship'
import {
  trackChildProcessGone,
  trackMainError,
  trackMainLog,
  trackMainUnhandledRejection,
  startActiveHeartbeat,
  stopActiveHeartbeat
} from './telemetry/diagnostics'
import { recordLaunchPhase, reportLaunchTimeline } from './launch-timeline'
import { toErrorCode } from '@memry/contracts/telemetry-api'
import { drainEarlyMainEvents, trackMainEvent } from './telemetry/track'
import {
  clearCrashMarker,
  detectUncleanShutdown,
  installCrashMarker,
  markShutdownFailure
} from './telemetry/crash-marker'
import { detectFailedUpdateInstall } from './telemetry/update-install-marker'
import {
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  triggerGoogleCalendarSyncNow
} from './calendar/google/sync-service'
import {
  log,
  createLogger,
  disableConsoleTransport,
  applyPackagedLogLevels,
  migrateLegacyLogDir
} from './lib/logger'
import { applyMemrynoteIdentity, flipIdentityPin, getIdentityDecision } from './app-identity'
import { probeSecretStoreIdentity } from './secrets/secret-storage'
import { isAllowedExternalUrl, isPathInsideDirs, resolveMemryFilePath } from './lib/external-url'
import { remapCrossDeviceAttachmentPath } from './lib/attachment-path-remap'
import { decideFrameNavigation } from './lib/frame-navigation'
import { registerTestHooks } from './test-hooks'
import {
  computeSpkiHashFromPem,
  isPinningDisabled,
  getPinnedCertificateHashes,
  getPinnedCertificateHashesForHostname,
  warnPinningUnconfiguredOnce
} from './sync/certificate-pinning'
import { getCrdtProvider } from './sync/crdt-provider'
import { stopSyncRuntime } from './sync/runtime'
import { beginAppShutdown, isAppShuttingDown } from './app-shutdown'
import { getValidAccessToken } from './sync/token-manager'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from './database/client'
import { toAbsolutePath, createSnapshot } from './vault/notes'
import { safeRead } from './vault/file-ops'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { SettingsChannels, InboxChannels } from '@memry/contracts/ipc-channels'
import { parseInboxOpenItemId } from './deeplink-utils'
import { initializeUpdater, isQuitAndInstallRequested, performQuitAndInstall } from './updater'
import { clearPendingInstallMarker, isPendingInstallInFlight } from './updater-install-guard'
import { applyGpuCrashGuard, recordGpuCrash, shouldRecordGpuCrash } from './gpu-crash-guard'
import { buildAppMenu, buildEditableTextContextMenu } from './menu'
import { getMainI18n, setMainI18n } from './lib/main-i18n'
import {
  sendAppNavigationCommand,
  sendAppNavigationKeyboardCommand,
  sendAppNavigationSwipeCommand,
  type AppNavigationSwipeDirection
} from './app-navigation-command'
import { getHeadlessCliArgs, runHeadlessCli } from './cli/headless'
import { reconcileBillingAndSync, startBillingCheckout } from './billing/paddle-billing'
import { openPairingWindow } from './capture/pairing'
import { startCaptureServer, stopCaptureServer } from './capture/server'
import { stopChatServer } from './ai-inline/ai-chat-server'
import { applyLoginShellPath } from './agent/cli/login-shell-path'

if (process.type === 'browser') {
  log.initialize()
}

function resolveDeviceId(): string | undefined {
  const deviceId = process.env.MEMRY_DEVICE
  if (deviceId !== 'dev' || app.isPackaged) {
    return deviceId
  }

  // Plain pnpm dev runs in every worktree; scope its persisted state by checkout path.
  const worktreeHash = createHash('sha256')
    .update(normalize(app.getAppPath()))
    .digest('hex')
    .slice(0, 8)
  return `dev-${worktreeHash}`
}

const deviceId = resolveDeviceId()

// Resolve this install's runtime identity (app name + userData dir) for
// production launches; dev profiles keep their per-device `memry-<id>` identity
// below. Fully synchronous and keychain-free, so it is settled before anything —
// including a headless `--cli` launch, which never reaches whenReady — can touch
// safeStorage. The app NAME decides which macOS Keychain item safeStorage uses,
// so an install carrying a pre-rename secret store keeps the legacy name.
if (!deviceId) applyMemrynoteIdentity()

/**
 * Confirm, by decrypting, that the identity we derived can actually read this
 * profile's secret store — the only exact test there is, since the store's
 * location never proved which key encrypted it.
 *
 * On a mismatch the other identity is pinned for the next launch. Deliberately
 * no app.relaunch(): forcing a restart mid-startup is a worse failure mode than
 * asking for one. flipIdentityPin() spends at most one flip per install, which
 * is what makes this converge.
 */
function verifySecretStoreIdentity(): void {
  try {
    const decision = getIdentityDecision()
    // No decision means a dev profile or a custom --user-data-dir: not ours.
    if (!decision || decision.flipped || !decision.pinned) return
    const verdict = probeSecretStoreIdentity()
    if (verdict !== 'wrong-identity') return
    const flipped = flipIdentityPin()
    trackMainError(
      'app_identity',
      flipped ? 'identity_flipped_for_next_launch' : 'identity_flip_failed',
      new Error(`secret store unreadable under "${decision.appName}" (${decision.reason})`)
    )
  } catch (err) {
    mainLog.warn('Secret store identity check failed', { error: err })
  }
}

let mainDiagnosticsRegistered = false

function registerMainDiagnostics(): void {
  if (mainDiagnosticsRegistered) return
  mainDiagnosticsRegistered = true

  process.on('uncaughtException', (error) => {
    trackMainError('main_process', 'uncaught_exception', error)
  })

  process.on('unhandledRejection', (reason) => {
    // A rejection reason can be any value, and a non-Error reason carries no
    // stack — those landed in telemetry as an unactionable `Error` with an
    // empty stack. trackMainUnhandledRejection normalizes it first.
    trackMainUnhandledRejection(reason)
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    trackMainLog('error', {
      scope: 'Electron',
      action: 'render_process_gone',
      errorCode: details.reason
    })
  })

  app.on('child-process-gone', (_event, details) => {
    // Idle utility workers (embeddings, image-processing, voice-model) exit
    // cleanly every ~30s — lifecycle, not a fault. trackChildProcessGone skips
    // clean exits and codes real faults as type:reason:serviceName.
    //
    // This is also the ONLY report a native worker crash produces: the worker's
    // own 'exit' event never fires for one, so the owning module never learns it
    // died. Resolving the lifecycle phase here is what lets that surviving report
    // say whether the user lost an embedding or the worker died tearing down.
    trackChildProcessGone({
      ...details,
      phase: getEmbeddingWorkerPhase(details.name) ?? undefined
    })
    // A dead GPU process means this launch may already be painting nothing.
    // Record it so the next launch disables hardware acceleration (see
    // gpu-crash-guard). Exclude 'clean-exit' (normal shutdown) and, since
    // Electron 40, 'memory-eviction' (OS memory-pressure kill) — neither is a
    // GPU fault, and mis-recording an eviction needlessly disables hardware
    // acceleration on the next launch.
    if (shouldRecordGpuCrash(details)) {
      recordGpuCrash()
    }
  })
}
if (deviceId) {
  process.env.MEMRY_DEVICE = deviceId
  app.name = `memry-${deviceId}`
  const deviceUserData = `${app.getPath('userData')}-${deviceId}`
  app.setPath('userData', deviceUserData)
}

// Existing installs logged into `@memry/desktop` (the raw package name);
// move that history into the `memrynote` dir before workers spawn and this
// launch's log volume starts landing there.
migrateLegacyLogDir()

// Must run before app 'ready': if a prior launch's GPU process crashed (old/
// blacklisted Windows GPUs paint nothing, leaving an invisible window), fall
// back to software rendering this launch instead of stranding the user.
applyGpuCrashGuard()

// Native crashes (the ones no JS handler ever sees) leave a minidump in
// app.getPath('crashDumps') for the Path B diagnostic bundle the user submits
// deliberately. uploadToServer is false and must STAY false: PostHog does not
// ingest minidumps, and a dump is raw process memory — shipping it would breach
// the redaction model every other telemetry path is built around. Started before
// 'ready' so renderer and utility processes inherit the handler.
crashReporter.start({ uploadToServer: false })

const mainLog = createLogger('Main')
const configLog = createLogger('Config')
const quickCaptureLog = createLogger('QuickCapture')
const shutdownLog = createLogger('Shutdown')
const deepLinkLog = createLogger('DeepLink')
const navGuardLog = createLogger('NavigationGuard')

// Hand a memry-file:// URL to the OS default app after allowlist-checking the
// resolved path against userData + vault dirs. Shared by the frame-navigation
// guard (main-frame memry-file: nav, which would otherwise trap the app) and the
// window-open handler, so the allowlist has a single source of truth. Returns
// true when the URL was a memry-file URL (and thus handled here).
function openMemryFileInOs(rawUrl: string): boolean {
  const memryFilePath = resolveMemryFilePath(rawUrl)
  if (!memryFilePath) return false
  const allowedDirs = [app.getPath('userData'), getCurrentVaultPath(), getVaultStatus().path]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => resolve(dir))
  if (isPathInsideDirs(memryFilePath, allowedDirs)) {
    void shell.openPath(memryFilePath)
  } else {
    log.warn('Blocked memry-file open outside allowed directories', { path: memryFilePath })
  }
  return true
}

// Frame-level navigation guard for every window's webContents: pins main-frame
// navigation to the local app origin and re-routes external links through
// shell.openExternal. Complements (does not replace) the per-window
// setWindowOpenHandler hardening, which only covers window.open.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-frame-navigate', (details) => {
    const decision = decideFrameNavigation(details.url, {
      isMainFrame: details.isMainFrame,
      currentUrl: contents.getURL(),
      isDev: is.dev
    })
    if (decision === 'allow') return
    details.preventDefault()
    if (decision === 'open-external' && isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else if (decision === 'open-file') {
      openMemryFileInOs(details.url)
    } else {
      navGuardLog.warn('Blocked frame navigation', {
        url: details.url.slice(0, 256),
        isMainFrame: details.isMainFrame
      })
    }
  })
})

// A Finder/Dock-launched packaged app inherits only the minimal system PATH, so
// user-installed CLIs (claude/codex) are invisible to `which` and Agent Chat
// greys out those providers. Recover the login-shell PATH before anything spawns
// a probe or the CLIs themselves. No-op in dev (terminal already has full PATH).
if (applyLoginShellPath({ packaged: app.isPackaged })) {
  mainLog.info('Augmented PATH from login shell for packaged launch')
}

const headlessCliArgs = getHeadlessCliArgs(process.argv)

let mainI18n: I18nInstance

if (headlessCliArgs) {
  disableConsoleTransport()
  void runHeadlessCli(headlessCliArgs).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
}

/**
 * Pick the UI language for a genuinely fresh install from the OS locale, and
 * persist it so the choice is made exactly once.
 *
 * A null stored locale is NOT enough to identify a fresh install — every
 * install that predates the app-level locale setting also has null, and those
 * users must keep the English UI they have been running. The real first-run
 * signal is the vault registry: `openVault()` writes `currentVault` and upserts
 * into `vaults` on every successful open, and nothing ever empties `vaults`
 * (`removeVault` only drops a single entry). An install that has ever opened a
 * vault therefore always has an entry here. `currentVault` is checked as well
 * because a config file written before `vaults` existed merges in as an empty
 * array — that user is an existing user, not a fresh install.
 *
 * Returns null when this is not a first run, leaving the caller's fallback in
 * place.
 */
function detectFirstRunLocale(): Locale | null {
  try {
    if (getCurrentVaultPath() !== null || getVaults().length > 0) return null

    const detected = resolveOsLocale(app.getLocale())
    setStoredLocale(detected)
    mainLog.info(`first run: adopting OS locale ${app.getLocale()} as ${detected}`)
    return detected
  } catch (error) {
    // Locale detection must never be the reason a launch fails; an unreadable
    // or unwritable config just means we keep the English fallback.
    mainLog.warn('first-run locale detection skipped:', error)
    return null
  }
}

async function bootI18n(): Promise<I18nInstance> {
  let initialLocale: Locale = getStoredLocale() ?? detectFirstRunLocale() ?? FALLBACK_LOCALE

  try {
    const vaultPath = getCurrentVaultPath()
    if (vaultPath) {
      const parsed = LocaleSchema.safeParse(readPreferences(vaultPath).language)
      if (parsed.success) initialLocale = parsed.data
    }
  } catch {
    // First launch or corrupt settings: fall back to English.
  }

  return createMainI18n({ locale: initialLocale })
}

function rebuildMenu(_locale: Locale): void {
  Menu.setApplicationMenu(buildAppMenu(mainI18n))
}

registerTestHooks()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    disableConsoleTransport()
    app.quit()
  })
}

type MemryEnvironment = 'development' | 'staging' | 'production'

function resolveMemryEnvironment(): MemryEnvironment {
  const requested = process.env.MEMRY_ENV?.trim()
  if (requested === 'development' || requested === 'staging' || requested === 'production') {
    return requested
  }

  return app.isPackaged ? 'production' : 'development'
}

// Load runtime env before any env access. Unpackaged builds use explicit
// .env.<environment> files; packaged apps receive Resources/app-config. The
// packaged file deliberately has no .env token: Windows Defender locks .env*
// files (credential scan), which broke packaging with EBUSY. See
// scripts/build-packaged-app.js + config/electron-builder*.yml.
const envPath = app.isPackaged
  ? join(process.resourcesPath, 'app-config')
  : join(app.getAppPath(), `.env.${resolveMemryEnvironment()}`)

const envResult = config({ path: envPath, quiet: true })
if (envResult.error) {
  // Try loading from current working directory as fallback
  config({ quiet: true })
}

// logger.ts defaults to verbose dev levels because NODE_ENV is undefined at
// runtime in packaged builds; correct it here where app.isPackaged is known.
if (app.isPackaged) {
  applyPackagedLogLevels()
}

mainLog.info(`MemryNote ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'dev'})`)

// Register custom protocol as privileged before app is ready
// This enables streaming support for audio/video elements
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'memry-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // Electron 43+ blocks cross-origin fetch()/XHR against a custom scheme
      // registered with supportFetchAPI unless corsEnabled is also set. no-cors
      // src loads (img/video/audio) are unaffected; this keeps fetch(memry-file)
      // byte reads (e.g. inline PDF embeds) working.
      corsEnabled: true,
      stream: true, // Required for audio/video streaming
      bypassCSP: false
    }
  }
])

// ============================================================================
// Environment Configuration
// ============================================================================

/**
 * Environment configuration for external services
 */
interface EnvironmentConfig {
  /** Optional environment OpenAI API key for development-only integrations */
  openaiApiKey: string | undefined
  /** Whisper model to use for transcription */
  whisperModel: string
  /** Embedding model to use for AI suggestions */
  embeddingModel: string
}

/**
 * Global environment configuration
 * Loaded once at startup, accessible throughout main process
 */
export const envConfig: EnvironmentConfig = {
  openaiApiKey: undefined,
  whisperModel: 'whisper-1',
  embeddingModel: 'text-embedding-3-small'
}

/**
 * Load and validate environment variables for external services
 */
function loadEnvironmentConfig(): void {
  // Optional development OpenAI API key
  envConfig.openaiApiKey = process.env.OPENAI_API_KEY

  if (!envConfig.openaiApiKey) {
    configLog.debug('OPENAI_API_KEY not set. Voice transcription will rely on BYOK settings.')
  } else {
    configLog.info('OpenAI API key loaded successfully')
  }

  // Optional: Override default models
  if (process.env.OPENAI_WHISPER_MODEL) {
    envConfig.whisperModel = process.env.OPENAI_WHISPER_MODEL
  }

  if (process.env.OPENAI_EMBEDDING_MODEL) {
    envConfig.embeddingModel = process.env.OPENAI_EMBEDDING_MODEL
  }
}

// Load environment config early
loadEnvironmentConfig()

function configureCsp(): void {
  const policy = [
    "default-src 'self' memry-file:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: memry-file: https:",
    "font-src 'self' data:",
    "connect-src 'self' memry-file: https://*.memrynote.com wss://*.memrynote.com https://cdn.syndication.twimg.com https://react-tweet.vercel.app http://127.0.0.1:*",
    "media-src 'self' memry-file:",
    "worker-src 'self' blob:",
    'frame-src https://www.youtube-nocookie.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ]

  if (is.dev) {
    policy[1] = "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
    policy[5] =
      "connect-src 'self' memry-file: https://*.memrynote.com wss://*.memrynote.com https://cdn.syndication.twimg.com https://react-tweet.vercel.app ws://localhost:* http://localhost:* http://127.0.0.1:*"
  }

  const cspString = policy.join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isOwnPage =
      details.url.startsWith('memry-file:') ||
      details.url.startsWith('file:') ||
      details.url.startsWith('http://localhost') ||
      details.url.startsWith('http://127.0.0.1')

    callback(
      isOwnPage
        ? {
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [cspString]
            }
          }
        : {}
    )
  })
}

const certPinLog = createLogger('CertPinSession')

function configureCertificatePinning(): void {
  if (isPinningDisabled()) {
    certPinLog.debug('Session cert pinning disabled (dev/test mode)')
    return
  }

  const pins = getPinnedCertificateHashes()

  if (pins.length === 0) {
    warnPinningUnconfiguredOnce()
    return
  }

  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const pinsForHostname = [...getPinnedCertificateHashesForHostname(request.hostname)]
    if (pinsForHostname.length === 0) {
      callback(0)
      return
    }

    const cert = request.certificate
    if (!cert.data) {
      certPinLog.error('Certificate missing PEM data', { hostname: request.hostname })
      callback(-2)
      return
    }

    try {
      const spkiHash = computeSpkiHashFromPem(cert.data)
      if (!pinsForHostname.some((pin) => pin === spkiHash)) {
        certPinLog.error('Session certificate pin mismatch', {
          hostname: request.hostname,
          hash: spkiHash
        })
        callback(-2)
        return
      }

      certPinLog.debug('Session certificate pin verified', { hostname: request.hostname })
      callback(0)
    } catch (err) {
      certPinLog.error('Certificate verification error', {
        hostname: request.hostname,
        error: err instanceof Error ? err.message : err
      })
      callback(-2)
    }
  })

  certPinLog.info('Session certificate pinning configured')
}

const DEFAULT_MAIN_WINDOW_SIZE = { width: 1550, height: 900 } as const
const VAULT_PICKER_WINDOW_SIZE = { width: 760, height: 560 } as const

function getInitialMainWindowSize():
  | typeof DEFAULT_MAIN_WINDOW_SIZE
  | typeof VAULT_PICKER_WINDOW_SIZE {
  if (process.env.MEMRY_FORCE_VAULT_PICKER === '1') return VAULT_PICKER_WINDOW_SIZE
  return getCurrentVaultPath() ? DEFAULT_MAIN_WINDOW_SIZE : VAULT_PICKER_WINDOW_SIZE
}

function resizeWindowIfNeeded(
  window: BrowserWindow,
  size: { width: number; height: number }
): void {
  if (window.isDestroyed()) return

  const [currentWidth, currentHeight] = window.getSize()
  if (currentWidth === size.width && currentHeight === size.height) return

  if (window.isMaximized()) {
    window.unmaximize()
  }
  window.setSize(size.width, size.height)
}

/**
 * Read the main window's geometry for persistence, or null when there is nothing
 * worth remembering. Guarded to the real app window — the compact vault picker is
 * never remembered. When maximized we report the *normal* (un-maximized) bounds
 * plus the flag, so a later restore can place the window correctly and re-maximize.
 */
function readWindowBounds(window: BrowserWindow): SavedWindowBounds | null {
  if (window.isDestroyed() || !getCurrentVaultPath()) return null
  const isMaximized = window.isMaximized()
  const { width, height, x, y } = isMaximized ? window.getNormalBounds() : window.getBounds()
  return { width, height, x, y, isMaximized }
}

function createWindow(): void {
  const initialSize = getInitialMainWindowSize()

  // Restore the user's last size/position only for the real app window (the vault
  // picker keeps its fixed compact size). "Real app window" means a vault is
  // already open — e.g. a macOS dock reopen — or one is about to auto-open at
  // startup (initialSize === DEFAULT). We check the live vault status too because
  // the dev-only MEMRY_FORCE_VAULT_PICKER flag shrinks initialSize to the picker,
  // which would otherwise skip restore for the whole dev workflow.
  const willShowVault = getVaultStatus().isOpen || initialSize === DEFAULT_MAIN_WINDOW_SIZE

  const startupBounds = willShowVault
    ? resolveStartupBounds(
        getWindowBounds(),
        screen.getAllDisplays().map((display) => ({ workArea: display.workArea })),
        DEFAULT_MAIN_WINDOW_SIZE
      )
    : { width: initialSize.width, height: initialSize.height, maximize: false }

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: startupBounds.width,
    height: startupBounds.height,
    ...(startupBounds.x !== undefined && startupBounds.y !== undefined
      ? { x: startupBounds.x, y: startupBounds.y }
      : {}),
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // Hide native traffic lights - we use custom ones
          trafficLightPosition: { x: -100, y: -100 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  if (startupBounds.maximize) mainWindow.maximize()
  recordLaunchPhase('window_created')

  // Remember geometry as the user resizes/moves/maximizes it, and on close. Every
  // persist rewrites the whole config file synchronously, so all four event streams
  // share one trailing debounce that also drops geometry identical to the last write
  // (maximize/unmaximize each fire alongside their own `resize`). `close` flushes so
  // the final geometry is never lost to a pending timer.
  const boundsPersister = createWindowBoundsPersister({
    read: () => readWindowBounds(mainWindow),
    write: setWindowBounds
  })
  mainWindow.on('resize', () => boundsPersister.schedule())
  mainWindow.on('move', () => boundsPersister.schedule())
  mainWindow.on('maximize', () => boundsPersister.schedule())
  mainWindow.on('unmaximize', () => boundsPersister.schedule())
  mainWindow.on('close', () => boundsPersister.flush())

  const unsubscribeVaultStatus = onVaultStatusChanged((status) => {
    if (mainWindow.isDestroyed()) return
    if (status.isOpen) {
      // Grow from the compact picker to the app window, but never fight a window
      // the user has already sized/moved/maximized (or that we just restored):
      // only act on the genuine picker → main transition.
      if (mainWindow.isMaximized()) return
      const [width, height] = mainWindow.getSize()
      const atPickerSize =
        width === VAULT_PICKER_WINDOW_SIZE.width && height === VAULT_PICKER_WINDOW_SIZE.height
      if (!atPickerSize) return
      const saved = getWindowBounds()
      resizeWindowIfNeeded(mainWindow, {
        width: saved?.width ?? DEFAULT_MAIN_WINDOW_SIZE.width,
        height: saved?.height ?? DEFAULT_MAIN_WINDOW_SIZE.height
      })
    } else {
      resizeWindowIfNeeded(mainWindow, VAULT_PICKER_WINDOW_SIZE)
    }
  })
  mainWindow.on('closed', unsubscribeVaultStatus)

  // The window is created hidden (show:false) and normally revealed on
  // 'ready-to-show'. On Windows a GPU/renderer crash before first paint can mean
  // that event never fires, leaving the process alive with no visible window and
  // no taskbar entry (unlike macOS, where the Dock still surfaces the app).
  // Guarantee visibility with a one-shot reveal guarded by a load-failure handler
  // and a fallback timeout, so a transient hiccup can't hide the app forever.
  let mainWindowShown = false
  const revealMainWindow = (reason: string): void => {
    if (mainWindowShown || mainWindow.isDestroyed()) return
    mainWindowShown = true
    clearTimeout(fallbackShowTimer)
    mainWindow.show()
    recordLaunchPhase('window_shown')
    mainLog.info(`main window shown (${reason})`)
    // Reveal is the moment the user stops staring at nothing, so it is where
    // the launch timeline is complete enough to attribute a slow start (#843).
    reportLaunchTimeline(reason)
  }

  const fallbackShowTimer = setTimeout(() => {
    mainLog.warn('ready-to-show did not fire within 10s; revealing window as fallback')
    revealMainWindow('fallback-timeout')
  }, 10_000)
  mainWindow.on('closed', () => clearTimeout(fallbackShowTimer))

  mainWindow.on('ready-to-show', () => {
    // Zoom out once (equivalent to Cmd+-)
    // mainWindow.webContents.setZoomLevel(-0.8)
    recordLaunchPhase('window_ready_to_show')
    revealMainWindow('ready-to-show')
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      // ERR_ABORTED (-3) is benign (e.g. a superseded navigation); don't reveal on it.
      if (errorCode === -3) return
      mainLog.error(
        `main window failed to load (${errorCode} ${errorDescription}) ${validatedURL}; revealing anyway`
      )
      // The user is now staring at a blank/broken renderer — make the rate of
      // failed first paints countable. The name is enum-ish so toErrorCode
      // adopts it; the URL never leaves the process.
      const failure = new Error()
      failure.name = `DidFailLoad:${errorCode}`
      trackMainError('main_window', 'did_fail_load', failure)
      revealMainWindow('did-fail-load')
    }
  )

  mainWindow.webContents.on('did-finish-load', () => {
    recordLaunchPhase('window_did_finish_load')
  })

  mainWindow.on('focus', () => {
    triggerGoogleCalendarSyncNow('window-focus')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (openMemryFileInOs(details.url)) {
      return { action: 'deny' }
    }
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else {
      log.warn('Blocked external open for disallowed URL scheme', { url: details.url })
    }
    return { action: 'deny' }
  })

  // Browser-style mouse-button navigation: Windows/Linux fire WM_APPCOMMAND for X1/X2.
  mainWindow.on('app-command', (_event, cmd) => {
    sendAppNavigationCommand(mainWindow.webContents, cmd)
  })

  mainWindow.on('swipe', (_event, direction) => {
    sendAppNavigationSwipeCommand(mainWindow.webContents, direction as AppNavigationSwipeDirection)
  })

  // Some mouse drivers expose browser side buttons as dedicated keyboard keys instead.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (sendAppNavigationKeyboardCommand(mainWindow.webContents, input)) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = buildEditableTextContextMenu(mainI18n, params)
    if (!menu) return

    menu.popup({
      window: mainWindow,
      ...(params.frame ? { frame: params.frame } : {})
    })
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// How long the pre-boot "Installing update…" splash stays up before we exit.
// Long enough to paint and be read, short enough to get out of ShipIt's way:
// keeping the old build alive is what makes Squirrel abort (Code=-9) and retry.
const INSTALLING_SPLASH_EXIT_MS = 2000

/**
 * Copy for the two windows that can open BEFORE `bootI18n()` assigns `mainI18n`,
 * so neither can reach `getMainI18n()`.
 */
interface PreBootCopy {
  dir: 'ltr' | 'rtl'
  installingTitle: string
  installingSubtitle: string
  startupErrorTitle: string
  startupErrorBody: string
}

/**
 * English copy, and the fallback whenever the pre-boot lookup below fails.
 * Neither window may ever fail to appear — the startup-error one is the
 * last-resort guard against an invisible, process-alive "zombie".
 */
const PRE_BOOT_COPY_EN: PreBootCopy = {
  dir: 'ltr',
  installingTitle: 'Installing update…',
  installingSubtitle: 'MemryNote will reopen automatically.',
  startupErrorTitle: "MemryNote couldn't finish starting",
  startupErrorBody:
    'This can happen when the disk is very low on free space, or with older graphics drivers. Try freeing up some disk space, then reopen MemryNote. If it keeps happening, reinstalling usually clears it.'
}

// The pre-boot lookup only reads locale JSON that is already bundled, so it
// resolves in microseconds — but these two windows exist precisely for launches
// that are already going wrong, so cap it rather than risk showing no window.
const PRE_BOOT_I18N_TIMEOUT_MS = 1500

/**
 * Resolve pre-boot copy from a throwaway i18n instance built on the OS locale.
 * Deliberately separate from `bootI18n()`: it leaves the app's boot order and
 * the `mainI18n` singleton untouched, and it is only paid on the rare launches
 * that show one of these windows.
 */
async function loadPreBootCopy(): Promise<PreBootCopy> {
  try {
    const instance = await Promise.race([
      createMainI18n({ locale: resolveOsLocale(app.getLocale()) }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('pre-boot i18n load timed out')),
          PRE_BOOT_I18N_TIMEOUT_MS
        )
      )
    ])
    const t = instance.getFixedT(null, 'system')
    return {
      dir: instance.dir(),
      installingTitle: t('startup.installingUpdate.title'),
      installingSubtitle: t('startup.installingUpdate.subtitle'),
      startupErrorTitle: t('startup.failed.title'),
      startupErrorBody: t('startup.failed.body')
    }
  } catch (error) {
    mainLog.warn('pre-boot i18n load failed; using English startup copy:', error)
    return PRE_BOOT_COPY_EN
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function installingSplashHtml(copy: PreBootCopy): string {
  return `<!doctype html>
<html dir="${copy.dir}"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{display:flex;align-items:center;justify-content:center;background:#f6f5f0;
    color:#191919;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-user-select:none;user-select:none}
  .card{text-align:center;padding:24px}
  .spinner{width:22px;height:22px;margin:0 auto 16px;border-radius:50%;
    border:2px solid rgba(25,25,25,.15);border-top-color:#ff671a;
    animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .title{font-weight:600;margin-bottom:6px}
  .sub{opacity:.55;font-size:13px}
  @media (prefers-reduced-motion:reduce){.spinner{animation:none}}
</style></head><body><div class="card">
  <div class="spinner"></div>
  <div class="title">${escapeHtml(copy.installingTitle)}</div>
  <div class="sub">${escapeHtml(copy.installingSubtitle)}</div>
</div></body></html>`
}

/**
 * Show a tiny "Installing update…" splash and exit, instead of booting normally.
 * Used when a Squirrel/ShipIt install we started is still running and the user
 * relaunched the old build. Booting here would re-show the update prompt AND
 * keep the old process alive, which makes ShipIt abort and re-verify from
 * scratch (the download → Restart loop). Exiting lets ShipIt finish and
 * relaunch the new build itself.
 */
async function showInstallingUpdateWindowAndExit(): Promise<void> {
  // Hard exit (not app.quit): nothing is initialized, so there is no graceful
  // shutdown to run, and app.quit() would spin up the before-quit cleanup path
  // against an empty app. app.exit ends the process so ShipIt can proceed.
  //
  // Scheduled BEFORE the copy lookup on purpose: this budget is how long the old
  // build is allowed to stay alive, and outliving it is exactly what makes
  // Squirrel abort (Code=-9) and retry. Localizing the splash must not extend it.
  setTimeout(() => app.exit(0), INSTALLING_SPLASH_EXIT_MS)
  const copy = await loadPreBootCopy()
  const splash = new BrowserWindow({
    width: 380,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    backgroundColor: '#faf9f7',
    center: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  splash.once('ready-to-show', () => splash.show())
  void splash.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(installingSplashHtml(copy))}`
  )
}

function startupErrorHtml(message: string, copy: PreBootCopy): string {
  return `<!doctype html>
<html dir="${copy.dir}"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%}
  body{display:flex;align-items:center;justify-content:center;background:#f6f5f0;
    color:#191919;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    -webkit-user-select:none;user-select:none;padding:28px;box-sizing:border-box}
  .card{max-width:420px}
  .title{font-weight:600;font-size:16px;margin-bottom:10px}
  .body{opacity:.75;line-height:1.5;margin-bottom:14px}
  .details{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.6;
    background:rgba(25,25,25,.05);border-radius:6px;padding:10px;white-space:pre-wrap;
    word-break:break-word;max-height:110px;overflow:auto;user-select:text}
</style></head><body><div class="card">
  <div class="title">${escapeHtml(copy.startupErrorTitle)}</div>
  <div class="body">${escapeHtml(copy.startupErrorBody)}</div>
  <div class="details" dir="ltr">${escapeHtml(message)}</div>
</div></body></html>`
}

/**
 * Last-resort guarantee that startup never leaves an invisible, process-alive
 * "zombie": if the whenReady chain throws before a window is created, surface a
 * small framed window explaining what happened instead of stranding the user
 * with a running process, no window, and the single-instance lock held. If a
 * real window already exists the failure came later — leave it untouched.
 */
function ensureStartupWindow(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  mainLog.error('startup failed before a window was shown:', error)
  trackMainError('main_process', 'startup_failed_no_window', error)

  if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return

  const errorWindow = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f6f5f0',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  errorWindow.once('ready-to-show', () => errorWindow.show())
  // Same failure class can stop 'ready-to-show' firing; reveal anyway after a beat.
  setTimeout(() => {
    if (!errorWindow.isDestroyed()) errorWindow.show()
  }, 3000)
  // The window is created synchronously above and revealed by the fallback timer
  // regardless, so resolving the localized copy can never be what leaves the
  // user with no window.
  void loadPreBootCopy().then((copy) => {
    if (errorWindow.isDestroyed()) return
    void errorWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(startupErrorHtml(message, copy))}`
    )
  })
}

const pendingOAuthStates = new Map<string, number>()

export const registerOAuthState = (state: string): void => {
  pendingOAuthStates.set(state, Date.now())
  setTimeout(() => pendingOAuthStates.delete(state), 10 * 60 * 1000)
}

function openAccountSettings(mainWindow: BrowserWindow): void {
  mainWindow.webContents.send(SettingsChannels.events.OPEN_SECTION, 'account')
}

async function showPairConsentDialog(origin: string): Promise<boolean> {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  const t = getMainI18n().getFixedT(null, 'system')
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [t('dialog.pair.buttonAllow'), t('dialog.pair.buttonDeny')],
    defaultId: 0,
    cancelId: 1,
    title: t('dialog.pair.title'),
    message: t('dialog.pair.message'),
    detail: origin
  })
  return response === 0
}

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'memry:') return

    // Deep links are the clipper/billing/pairing entry funnel; count the
    // intent even when no window is up to act on it. Only the coarse target
    // ships — never the URL, which can carry ids and OAuth params.
    const target =
      parsed.hostname === 'open'
        ? 'open'
        : parsed.hostname === 'billing'
          ? parsed.pathname === '/start'
            ? 'billing_start'
            : parsed.pathname === '/complete'
              ? 'billing_complete'
              : 'billing'
          : parsed.hostname === 'oauth' || parsed.pathname.startsWith('/oauth')
            ? 'oauth'
            : parsed.hostname === 'pair'
              ? 'pair'
              : 'unknown'
    trackMainEvent('deep_link_opened', {
      surface: 'app',
      action: 'opened',
      dimensions: { target }
    })

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return

    if (parsed.hostname === 'open') {
      // launch/focus only — no dialog. Restore+focus happens below for any memry:// url.
      deepLinkLog.info('launch requested via memry://open')
      const itemId = parseInboxOpenItemId(url)
      if (itemId) mainWindow.webContents.send(InboxChannels.events.OPEN_ITEM, itemId)
    }

    if (parsed.hostname === 'billing') {
      if (parsed.pathname === '/start') {
        openAccountSettings(mainWindow)
        void startBillingCheckout()
      } else if (parsed.pathname === '/complete') {
        const transactionId = parsed.searchParams.get('transactionId') ?? undefined
        openAccountSettings(mainWindow)
        void reconcileBillingAndSync({ transactionId })
      }
    }

    if (parsed.hostname === 'oauth' || parsed.pathname.startsWith('/oauth')) {
      const code = parsed.searchParams.get('code')
      const state = parsed.searchParams.get('state')
      if (code && state && pendingOAuthStates.has(state)) {
        pendingOAuthStates.delete(state)
        mainWindow.webContents.send('auth:oauth-callback', { code, state })
      }
    }

    if (parsed.hostname === 'pair') {
      // getMainI18n() throws until bootI18n() has run. That is only reachable when
      // the sole window is the pre-boot install splash or the startup-error window,
      // but it must not abort the handler: the restore/focus below has to run for
      // every memry:// url, as it did before this dialog was localized.
      try {
        const i18n = getMainI18n()
        const t = i18n.getFixedT(null, 'system')
        void dialog
          .showMessageBox(mainWindow, {
            type: 'question',
            buttons: [t('dialog.pair.buttonPair'), i18n.t('common:button.cancel')],
            defaultId: 0,
            cancelId: 1,
            title: t('dialog.pair.title'),
            message: t('dialog.pair.message')
          })
          .then(({ response }) => {
            if (response === 0) openPairingWindow()
          })
      } catch (error) {
        deepLinkLog.error('pair prompt skipped; i18n not ready:', error)
      }
    }

    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } catch {
    deepLinkLog.error('failed to parse URL:', url)
  }
}

const allowMultiInstanceForDeviceTests =
  process.env.NODE_ENV === 'test' && typeof process.env.MEMRY_DEVICE === 'string'

// Windows/Linux: deep links arrive via second-instance event.
// Device-scoped E2E runs need two Electron instances side by side, so skip the
// process-wide lock only for that test harness path.
if (!headlessCliArgs && !allowMultiInstanceForDeviceTests) {
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
  } else {
    app.on('second-instance', (_event, commandLine) => {
      // A second launch (e.g. double-clicking the shortcut while the app is
      // already running) must surface the existing window, not silently no-op.
      // On Windows there is no Dock/'activate' fallback, so without this a hidden
      // or minimized instance stays invisible and the app looks like it "won't open".
      const existing = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (existing) {
        if (!existing.isVisible()) existing.show()
        if (existing.isMinimized()) existing.restore()
        existing.focus()
      }
      const deepLinkUrl = commandLine.find((arg) => arg.startsWith('memry://'))
      if (deepLinkUrl) {
        handleDeepLink(deepLinkUrl)
      }
    })
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
const appReady = app.whenReady().then(async () => {
  // Register the process-level nets before ANY other startup work: failures in
  // the identity carry-over / pending-install window used to happen before the
  // handlers existed and vanished. trackMainError buffers until the telemetry
  // runtime initializes (see telemetry/track.ts), so these early reports ship
  // once it does. The later registerMainDiagnostics call is an idempotent no-op.
  registerMainDiagnostics()
  // The identity itself is already settled (module scope, see applyMemrynoteIdentity).
  // safeStorage only becomes usable after 'ready', so this is the first point at
  // which we can check the derivation by actually decrypting something. On a
  // mismatch we pin the other identity for the NEXT launch rather than relaunching
  // mid-startup — at most one flip, so this always terminates.
  verifySecretStoreIdentity()
  if (headlessCliArgs) return

  // Test-only reproduction of the customer's "app won't open" case: a startup that
  // fails BEFORE the main window is created (ENOSPC on a full disk / GPU crash),
  // leaving a process alive with no window. Inert outside the E2E harness (which
  // sets NODE_ENV=test); never active in a shipped build.
  if (process.env.NODE_ENV === 'test' && process.env.MEMRY_TEST_FORCE_STARTUP_THROW === '1') {
    throw new Error('E2E: forced startup failure before window creation')
  }

  // Auto-update guard: if a Squirrel/ShipIt install we started is still running
  // and the user relaunched the OLD build (Dock icon vanishes during the swap),
  // do NOT boot + re-prompt. Booting keeps the old process alive — which makes
  // ShipIt abort with Code=-9 and re-verify from scratch — and re-shows the
  // update prompt, i.e. the download → Restart loop. Show a brief installer
  // splash and exit so ShipIt can finish and relaunch the new build itself.
  if (isPendingInstallInFlight()) {
    mainLog.info('pending update install in flight on launch; showing splash and exiting')
    await showInstallingUpdateWindowAndExit()
    return
  }
  // Normal boot commits — drop any leftover pending-install marker.
  clearPendingInstallMarker()

  // Load React DevTools using new session.extensions API (Electron 38+)
  // Note: Some console errors about "sandboxed_renderer.bundle.js" and "Autofill"
  // are expected and harmless - they're caused by Chrome DevTools internals
  if (is.dev) {
    try {
      const REACT_DEVTOOLS_ID = 'fmkadmapgofadopljbjfkapdkoienihi'
      const chromeExtensionsPath =
        process.platform === 'darwin'
          ? join(homedir(), 'Library/Application Support/Google/Chrome/Default/Extensions')
          : process.platform === 'win32'
            ? join(homedir(), 'AppData/Local/Google/Chrome/User Data/Default/Extensions')
            : join(homedir(), '.config/google-chrome/Default/Extensions')

      const extensionDir = join(chromeExtensionsPath, REACT_DEVTOOLS_ID)

      if (existsSync(extensionDir)) {
        // Get the latest version directory
        const versions = readdirSync(extensionDir).filter((v) => !v.startsWith('.'))
        if (versions.length > 0) {
          const latestVersion = versions.sort().pop()!
          const extensionPath = join(extensionDir, latestVersion)

          // Check if extensions API is available (Electron 38+)
          if (session.defaultSession.extensions?.loadExtension) {
            const extension = await session.defaultSession.extensions.loadExtension(extensionPath)
            mainLog.debug(`added extension: ${extension.name}`)
          } else {
            mainLog.debug('React DevTools: session.extensions API not available')
          }
        }
      } else {
        mainLog.debug('React DevTools not found. Install it in Chrome to enable.')
      }
    } catch (err) {
      // Extension loading can fail for various reasons (version mismatch, sandbox issues)
      // This is non-critical for development
      mainLog.debug('failed to load React DevTools:', err instanceof Error ? err.message : err)
    }
  }

  // Set app user model id for windows. Must match the electron-builder appId
  // (config/electron-builder.yml) so the taskbar button, pinned shortcut, and
  // notifications all attribute to the same app identity.
  electronApp.setAppUserModelId('com.memrynote.memry')

  // Register memry:// deep link protocol for OAuth callbacks (T041e)
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('memry', process.execPath, [resolve(process.argv[1])])
  } else if (!app.isDefaultProtocolClient('memry')) {
    app.setAsDefaultProtocolClient('memry')
  }

  // Register custom protocol for serving local attachment files
  // This allows secure access to vault files from the renderer process
  protocol.handle('memry-file', async (request) => {
    // URL format: memry-file://local/absolute/path/to/file
    // Using 'local' as explicit host to avoid URL parsing issues
    const url = new URL(request.url)
    // The pathname is URL-encoded, need to decode it
    let filePath = decodeURIComponent(url.pathname)

    // On macOS/Linux, the path should be absolute (starts with /)
    if (process.platform !== 'win32') {
      // Ensure the path starts with /
      if (!filePath.startsWith('/')) {
        filePath = '/' + filePath
      }
    } else {
      // On Windows, remove the leading slash from /C:/path/to/file
      if (filePath.startsWith('/')) {
        filePath = filePath.slice(1)
      }
    }

    filePath = resolve(normalize(filePath))

    const allowedDirs: string[] = [app.getPath('userData')]
    const vaultPaths = [getCurrentVaultPath(), getVaultStatus().path].filter(
      (vaultPath): vaultPath is string => Boolean(vaultPath)
    )
    for (const vaultPath of vaultPaths) {
      const resolvedVaultPath = resolve(vaultPath)
      if (!allowedDirs.includes(resolvedVaultPath)) allowedDirs.push(resolvedVaultPath)
    }

    let isAllowed = isPathInsideDirs(filePath, allowedDirs)
    if (!isAllowed) {
      // Note blocks store the ORIGIN machine's absolute path (memry-file://local/<abs>),
      // so a note synced from another device points at a path that doesn't exist
      // here. The bytes live at the same attachments/<noteId>/<file> spot inside
      // this device's vault — serve from there when present.
      const remapped = remapCrossDeviceAttachmentPath(filePath, vaultPaths)
      if (remapped) {
        mainLog.debug('memry-file: remapped cross-device attachment path', {
          requested: filePath,
          remapped
        })
        filePath = remapped
        isAllowed = true
      }
    }
    if (!isAllowed) {
      mainLog.warn('memry-file: blocked path outside allowed directories', { filePath })
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    }

    if (!existsSync(filePath)) {
      // Return empty 1x1 transparent PNG for missing image files (null thumbnails)
      // This avoids console errors and broken image icons
      if (
        filePath.endsWith('.png') ||
        filePath.endsWith('.jpg') ||
        filePath.endsWith('.jpeg') ||
        filePath.endsWith('.gif') ||
        filePath.endsWith('.webp')
      ) {
        // 1x1 transparent PNG
        const transparentPng = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
          'base64'
        )
        return new Response(transparentPng, {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        })
      }
      // Return 404 for other missing files
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }

    try {
      const stats = statSync(filePath)
      const fileSize = stats.size
      const mimeType = mimeLookup(filePath) || 'application/octet-stream'

      // Check for Range header (needed for video/audio seeking)
      const rangeHeader = request.headers.get('Range')

      if (rangeHeader) {
        // Parse Range header (e.g., "bytes=0-1023")
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/)
        if (match) {
          const start = match[1] ? parseInt(match[1], 10) : 0
          const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
          const chunkSize = end - start + 1

          // Create readable stream for the range
          const stream = createReadStream(filePath, { start, end })
          const chunks: Buffer[] = []

          for await (const chunk of stream) {
            chunks.push(Buffer.from(chunk))
          }

          const buffer = Buffer.concat(chunks)

          return new Response(buffer, {
            status: 206,
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes'
            }
          })
        }
      }

      // No Range header - return full file
      return net.fetch(`file://${filePath}`)
    } catch (error) {
      // A failure here renders as a silently broken image/PDF/video embed
      // (EACCES/EIO/file vanished mid-read — the class behind #896). Leave a
      // trace before answering 404; the path itself never leaves the process.
      mainLog.warn('memry-file: serve failed', { error })
      trackMainLog('warn', {
        scope: 'MemryFile',
        action: 'serve_failed',
        errorCode: toErrorCode(error)
      })
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
  })

  mainI18n = await bootI18n()
  setMainI18n(mainI18n)
  // setAboutPanelOptions is macOS/Linux only (undefined on Windows).
  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: 'MemryNote (Beta)',
      applicationVersion: app.getVersion(),
      copyright: `© ${new Date().getFullYear()} MemryNote`
    })
  }
  Menu.setApplicationMenu(buildAppMenu(mainI18n))

  // Initialize telemetry runtime before handlers so registerTelemetryHandlers
  // can resolve `getTelemetryRuntime()` to the live instance.
  // Both queues mirror to userData so a hard crash no longer discards the last
  // flush interval — including the app_crashed event detectUncleanShutdown is
  // about to record. Resolved here rather than inside the telemetry modules, for
  // the same reason installLogShip is: nothing under telemetry/ reaches for
  // process-wide state on its own.
  const telemetryDir = app.getPath('userData')
  const telemetryRuntime = initializeTelemetryRuntime({
    appVersion: app.getVersion(),
    locale: app.getLocale(),
    buildChannel: resolveMemryEnvironment(),
    authStateProvider: getTelemetryAuthState,
    syncStateProvider: getTelemetrySyncState,
    accessTokenProvider: () => getValidAccessToken(),
    persistPath: join(telemetryDir, 'telemetry-event-queue.json')
  })
  drainEarlyMainEvents()
  installLogShip({
    buildChannel: resolveMemryEnvironment(),
    persistPath: join(telemetryDir, 'telemetry-log-queue.json')
  })
  registerMainDiagnostics()
  // Order matters: detect the PREVIOUS session's leftover marker before this
  // session writes its own.
  detectUncleanShutdown()
  // Same shape as the crash marker: an update install that never applied left a
  // marker behind because the failure itself happened after this runtime was
  // disposed on the previous quit.
  detectFailedUpdateInstall(app.getVersion())
  installCrashMarker(telemetryRuntime.context.sessionId, app.getVersion())
  startActiveHeartbeat(() => BrowserWindow.getFocusedWindow() !== null)

  app.on('browser-window-blur', () => {
    setImmediate(() => {
      if (BrowserWindow.getFocusedWindow() === null) {
        trackMainEvent('app_backgrounded', { surface: 'app', action: 'backgrounded' })
      }
    })
  })

  recordLaunchPhase('app_ready')

  registerAllHandlers({ i18n: mainI18n, rebuildMenu })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => mainLog.debug('pong'))

  // Window control IPC handlers
  ipcMain.on('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow()
    win?.minimize()
  })

  ipcMain.on('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window-close', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    flushWindow(win)
      .then(() => createCloseSnapshots())
      .then(() => win.close())
      .catch((err) => {
        // The window silently refuses to close AND edits may be unsaved —
        // both symptoms arrive as support reports with no trail otherwise.
        mainLog.error('Window close flush failed:', err)
        trackMainError('main_process', 'window_close_flush_failed', err)
      })
  })

  // Quick Capture IPC handlers
  ipcMain.on('quick-capture:close', () => {
    closeQuickCaptureWindow()
  })

  ipcMain.handle('quick-capture:get-clipboard', () => {
    return clipboard.readText()
  })

  ipcMain.on('quick-capture:resize', (_event, height: number) => {
    if (!quickCaptureWindow || quickCaptureWindow.isDestroyed()) return
    const clamped = Math.max(120, Math.min(400, Math.round(height)))
    const [width] = quickCaptureWindow.getSize()
    quickCaptureWindow.setSize(width, clamped)
  })

  ipcMain.on('quick-capture:open-settings', (_event, section?: string) => {
    const mainWindow = BrowserWindow.getAllWindows().find(
      (win) => win !== quickCaptureWindow && !win.isDestroyed()
    )

    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      mainWindow.webContents.send(SettingsChannels.events.OPEN_SECTION, section ?? 'general')
    }

    closeQuickCaptureWindow()
  })

  // Deep link handler for memry:// protocol (T041e)
  // macOS: deep links arrive via open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

  // Native context menu handler
  ipcMain.handle(
    'context-menu:show',
    async (
      _event,
      items: Array<{
        id: string
        label: string
        accelerator?: string
        disabled?: boolean
        type?: 'normal' | 'separator'
      }>
    ) => {
      if (process.env.NODE_ENV === 'test') {
        const globals = globalThis as typeof globalThis & {
          __memryNextContextMenuSelection?: string | null
          __memryLastContextMenuItems?: Array<{
            id: string
            label: string
            accelerator?: string
            disabled?: boolean
            type?: 'normal' | 'separator'
          }>
        }
        globals.__memryLastContextMenuItems = items
        if (globals.__memryNextContextMenuSelection !== undefined) {
          const selection = globals.__memryNextContextMenuSelection
          delete globals.__memryNextContextMenuSelection
          return selection
        }
      }

      return new Promise<string | null>((resolve) => {
        const menu = new Menu()
        let resolved = false

        for (const item of items) {
          if (item.type === 'separator') {
            menu.append(new MenuItem({ type: 'separator' }))
          } else {
            menu.append(
              new MenuItem({
                label: item.label,
                accelerator: item.accelerator,
                enabled: !item.disabled,
                click: () => {
                  if (!resolved) {
                    resolved = true
                    resolve(item.id)
                  }
                }
              })
            )
          }
        }

        // Handle menu closing without selection
        menu.once('menu-will-close', () => {
          setTimeout(() => {
            if (!resolved) {
              resolved = true
              resolve(null)
            }
          }, 100)
        })

        menu.popup()
      })
    }
  )

  // Initialize CRDT persistence early so offline-created notes survive app restarts.
  // Sync callbacks (queue, snapshot push) attach later when auth is ready.
  getCrdtProvider()
    .initPersistence()
    .catch((err) => mainLog.warn('Early CRDT persistence init failed (non-fatal)', err))

  // Register global shortcut for quick capture from keyboard settings (fallback: hardcoded default).
  // The handler also runs on every later re-apply (keyboard settings save), so a save can no
  // longer leave quick capture with no working shortcut at all.
  setGlobalCaptureAppliedHandler(syncQuickCaptureFallbackShortcut)
  applyGlobalCaptureShortcut()
  registerQuickCaptureTestHooks()

  // Configure CSP, cert pinning, and permission handlers before the window loads
  configureCsp()
  configureCertificatePinning()
  configureSessionPermissions()

  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = join(__dirname, '../../build/icon.png')
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }

  createWindow()
  initializeUpdater()

  // Open the last vault and start schedulers concurrently with renderer load.
  // The renderer subscribes to vault status events and updates automatically.
  //
  // Vault open runs on the main process (migrations, indexing), so it is the
  // prime suspect when the window reveal misses its deadline. Time it up to
  // isOpen — not to the promise, which also waits on the first full sync. Only
  // when there is a vault to restore: a launch onto the picker has no such
  // phase, and stamping one would report it as forever-pending.
  if (getCurrentVaultPath()) {
    recordLaunchPhase('vault_open_start')
    let unsubscribeLaunchVaultStatus: (() => void) | null = onVaultStatusChanged((status) => {
      if (!status.isOpen) return
      recordLaunchPhase('vault_open_ready')
      unsubscribeLaunchVaultStatus?.()
      unsubscribeLaunchVaultStatus = null
    })
  }
  void autoOpenLastVault()
    .then(async () => {
      // autoOpenLastVault blocks on the vault's first fullSync; if the user quit
      // during it, shutdown has already stopped these services — do not re-arm
      // them here (that was the mid-shutdown capture-server/scheduler restart).
      if (isAppShuttingDown()) {
        mainLog.info('skipping post-vault-open startup: app is shutting down')
        return
      }
      try {
        checkDueItemsOnStartup()
        startSnoozeScheduler()
      } catch (error) {
        mainLog.warn('snooze scheduler failed to start:', error)
        trackMainLog('warn', {
          scope: 'Startup',
          action: 'snooze_scheduler_start_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError'
        })
      }
      try {
        startReminderScheduler()
      } catch (error) {
        mainLog.warn('reminder scheduler failed to start:', error)
        trackMainLog('warn', {
          scope: 'Startup',
          action: 'reminder_scheduler_start_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError'
        })
      }
      try {
        startInboxReviewScheduler()
      } catch (error) {
        mainLog.warn('inbox review scheduler failed to start:', error)
        trackMainLog('warn', {
          scope: 'Startup',
          action: 'inbox_review_scheduler_start_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError'
        })
      }
      void startGoogleCalendarSyncRunner().catch((error) => {
        mainLog.warn('Google Calendar sync runner failed to start:', error)
        trackMainLog('warn', {
          scope: 'Startup',
          action: 'google_calendar_sync_start_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError'
        })
      })
      void startCaptureServer({ requestPairConsent: showPairConsentDialog }).catch((err) =>
        mainLog.error('capture server failed to start', err)
      )
    })
    .catch((err) => {
      mainLog.error('autoOpenLastVault failed:', err)
      trackMainError('main_process', 'auto_open_last_vault_failed', err)
    })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// A throw anywhere in the async startup above (e.g. ENOSPC on a full disk opening
// SQLite/logs) would otherwise reject unhandled, leaving createWindow() unreached:
// process alive, no window, no taskbar entry, single-instance lock held. Guarantee
// a visible window instead.
void appReady.catch((error) => {
  ensureStartupWindow(error)
})

// ============================================================================
// Quick Capture Window (Global Shortcut: Cmd+Shift+Space)
// ============================================================================

/** Reference to the quick capture window instance */
let quickCaptureWindow: BrowserWindow | null = null

const QUICK_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space'

const quickCaptureShortcutRegistration = {
  shortcut: QUICK_CAPTURE_SHORTCUT,
  configuredRegistered: false,
  fallbackAttempted: false,
  fallbackRegistered: false,
  registered: false
}

/**
 * Show the quick capture window centered on screen.
 * Creates a new window if one doesn't exist, or focuses the existing one.
 */
function showQuickCaptureWindow(): void {
  // If window already exists, just focus it
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) {
    quickCaptureWindow.focus()
    return
  }

  // Get the primary display's work area to center the window
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  const windowWidth = 480
  const windowHeight = 82

  // Calculate center position
  const x = Math.round((screenWidth - windowWidth) / 2)
  const y = Math.round((screenHeight - windowHeight) / 2)

  quickCaptureWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x,
    y,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    transparent: false,
    hasShadow: true,
    vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Load the quick capture route
  // Note: Hash routing is used to pass the route to the renderer
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    // In dev mode, append hash to the Vite dev server URL
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    // Remove trailing slash if present to avoid double slashes
    const baseUrl = devUrl.endsWith('/') ? devUrl.slice(0, -1) : devUrl
    const url = `${baseUrl}/#/quick-capture`
    quickCaptureLog.debug('loading URL:', url)
    void quickCaptureWindow.loadURL(url)
  } else {
    // In production, load the HTML file with hash
    const filePath = join(__dirname, '../renderer/index.html')
    quickCaptureLog.debug('loading file:', filePath)
    void quickCaptureWindow.loadFile(filePath, {
      hash: 'quick-capture'
    })
  }

  // Handle load failures
  quickCaptureWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    quickCaptureLog.error('failed to load:', errorCode, errorDescription)
  })

  // Show window when ready
  quickCaptureWindow.once('ready-to-show', () => {
    quickCaptureWindow?.show()
    quickCaptureWindow?.focus()
  })

  // Close when window loses focus (clicking outside)
  quickCaptureWindow.on('blur', () => {
    // Small delay to allow for click handling within the window
    setTimeout(() => {
      if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) {
        quickCaptureWindow.close()
      }
    }, 100)
  })

  // Clean up reference when window is closed
  quickCaptureWindow.on('closed', () => {
    quickCaptureWindow = null
  })
}

/**
 * Close the quick capture window if it exists
 */
function closeQuickCaptureWindow(): void {
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) {
    quickCaptureWindow.close()
  }
}

/**
 * Register the global shortcut for quick capture
 */
function handleQuickCaptureShortcut(): void {
  showQuickCaptureWindow()
}

function registerQuickCaptureShortcut(): void {
  // Idempotent: a re-apply must not register an accelerator we already hold.
  if (quickCaptureShortcutRegistration.fallbackRegistered) {
    quickCaptureShortcutRegistration.registered = true
    return
  }

  const registered = globalShortcut.register(QUICK_CAPTURE_SHORTCUT, handleQuickCaptureShortcut)

  quickCaptureShortcutRegistration.fallbackAttempted = true
  quickCaptureShortcutRegistration.fallbackRegistered = registered
  quickCaptureShortcutRegistration.registered =
    quickCaptureShortcutRegistration.configuredRegistered || registered

  if (!registered) {
    quickCaptureLog.warn(
      `failed to register global shortcut: ${QUICK_CAPTURE_SHORTCUT}. It may be in use by another application.`
    )
    // Both the configured and the fallback shortcut failed: quick capture is
    // dead for this install. Countable, not just a local warn line.
    if (!quickCaptureShortcutRegistration.registered) {
      trackMainLog('warn', {
        scope: 'QuickCapture',
        action: 'global_shortcut_register_failed'
      })
    }
  }
}

function unregisterQuickCaptureFallbackShortcut(): void {
  if (!quickCaptureShortcutRegistration.fallbackRegistered) return

  globalShortcut.unregister(QUICK_CAPTURE_SHORTCUT)
  quickCaptureShortcutRegistration.fallbackRegistered = false
}

/**
 * Keep the hardcoded fallback shortcut in step with the configured global capture
 * accelerator. Runs at startup and after every keyboard settings save, so saving
 * settings can no longer drop the fallback (or report one that is not registered).
 */
function syncQuickCaptureFallbackShortcut(configuredRegistered: boolean): void {
  quickCaptureShortcutRegistration.configuredRegistered = configuredRegistered

  if (configuredRegistered) {
    unregisterQuickCaptureFallbackShortcut()
    quickCaptureShortcutRegistration.registered = true
    return
  }

  registerQuickCaptureShortcut()
}

function registerQuickCaptureTestHooks(): void {
  if (process.env.NODE_ENV !== 'test') return
  const hooks = globalThis.__memryTestHooks
  if (!hooks) return

  Object.assign(hooks, {
    async triggerQuickCaptureShortcutForE2E(): Promise<number> {
      handleQuickCaptureShortcut()
      if (!quickCaptureWindow || quickCaptureWindow.isDestroyed()) {
        throw new Error('Quick Capture window was not created')
      }
      return quickCaptureWindow.id
    },

    getQuickCaptureShortcutRegistrationForE2E(): typeof quickCaptureShortcutRegistration {
      return { ...quickCaptureShortcutRegistration }
    }
  })
}

// ============================================================================
// Shutdown Handling
// ============================================================================

// Track if shutdown is already in progress to prevent duplicate handling
let isShuttingDown = false

const FLUSH_DONE_CHANNEL = 'app:flush-done'

interface PendingFlush {
  windowId: number
  webContents: Electron.WebContents
  settle: () => void
}

// One entry per in-flight flush, keyed by request id. `app:flush-done` used to
// get one ipcMain listener per window, so a multi-window quit registered N
// listeners on the same channel and tripped Node's MaxListenersExceededWarning
// past 10 windows. The request id already scopes each reply, so a single shared
// listener plus this map does the same job with a constant listener count.
const pendingFlushes = new Map<string, PendingFlush>()
let flushDoneListenerAttached = false

// A reply only counts when it comes from the window we asked AND answers the
// request we are waiting on. Without both checks the first window to reply
// resolved all of them, and a late reply to an earlier request satisfied the
// next one — either way a renderer gets torn down with unsaved edits pending.
const handleFlushDone = (event: IpcMainEvent, doneRequestId?: string): void => {
  if (typeof doneRequestId !== 'string') return
  const pending = pendingFlushes.get(doneRequestId)
  if (!pending) return
  if (event.sender !== pending.webContents) return
  shutdownLog.info('flushWindow: flush-done received from window', pending.windowId)
  pending.settle()
}

function addPendingFlush(requestId: string, pending: PendingFlush): void {
  pendingFlushes.set(requestId, pending)
  if (flushDoneListenerAttached) return
  ipcMain.on(FLUSH_DONE_CHANNEL, handleFlushDone)
  flushDoneListenerAttached = true
}

function removePendingFlush(requestId: string): void {
  pendingFlushes.delete(requestId)
  if (pendingFlushes.size > 0 || !flushDoneListenerAttached) return
  // Detach once nothing is waiting. The timeout path used to skip cleanup: a
  // renderer that never answers left a listener on the shared ipcMain forever,
  // and window-close runs this on every close.
  ipcMain.removeListener(FLUSH_DONE_CHANNEL, handleFlushDone)
  flushDoneListenerAttached = false
}

function flushWindow(win: BrowserWindow, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed() || !win.webContents) {
      shutdownLog.info('flushWindow: window already destroyed', win.id)
      resolve()
      return
    }

    shutdownLog.info('flushWindow: requesting flush from window', win.id)

    const requestId = randomUUID()
    let settled = false

    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removePendingFlush(requestId)
      resolve()
    }

    const timer = setTimeout(() => {
      shutdownLog.warn('flushWindow: timeout for window', win.id)
      settle()
    }, timeoutMs)

    addPendingFlush(requestId, { windowId: win.id, webContents: win.webContents, settle })
    win.webContents.send('app:request-flush', requestId)
  })
}

async function flushAllWindows(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (windows.length === 0) return
  shutdownLog.info(`flushing ${windows.length} window(s)...`)
  await Promise.allSettled(windows.map((w) => flushWindow(w)))
  shutdownLog.info('flush complete')
}

async function createCloseSnapshots(): Promise<void> {
  try {
    const provider = getCrdtProvider()
    const openNoteIds = provider.getOpenNoteIds()
    if (openNoteIds.length === 0) return

    const indexDb = getIndexDatabase()
    let created = 0

    for (const noteId of openNoteIds) {
      try {
        const cached = getNoteCacheById(indexDb, noteId)
        if (!cached) continue
        const absolutePath = toAbsolutePath(cached.path)
        const fileContent = await safeRead(absolutePath)
        if (!fileContent) continue
        const result = createSnapshot(noteId, fileContent, cached.title, SnapshotReasons.CLOSE)
        if (result) created++
      } catch (err) {
        shutdownLog.error('close snapshot failed', { noteId, error: err })
      }
    }

    if (created > 0) {
      shutdownLog.info(`created ${created} close snapshot(s)`)
    }
  } catch {
    shutdownLog.warn('skipped close snapshots (provider not initialized)')
  }
}

// Graceful shutdown: close vault and databases before quitting
app.on('before-quit', (event) => {
  if (headlessCliArgs) return

  // Prevent duplicate shutdown handling
  if (isShuttingDown) return
  isShuttingDown = true

  event.preventDefault()

  // Stop broadcasting vault status to the renderer: the window is on its way
  // out, and a closeVault() during cleanup would otherwise flip the UI to the
  // vault picker (isOpen:false) right before the app quits/installs.
  beginVaultShutdown()

  // Latch app shutdown so in-flight startup work (a slow first fullSync inside
  // autoOpenLastVault) can't re-arm the sync runtime / capture server after the
  // cleanup below stops them. Must be set before the async cleanup chain yields.
  beginAppShutdown()

  shutdownLog.info('starting graceful shutdown...')

  // Set timeout to force exit if shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    // If the user asked to install an update, still hand off to Squirrel/NSIS
    // rather than app.exit() — a hard exit skips the install (and bypasses
    // autoInstallOnAppQuit), so the update never applies and the app re-prompts.
    // The forced exit below never flushes the log queue; the crash marker is
    // what carries this failure to the next launch (SHUTDOWN_TIMEOUT).
    markShutdownFailure('timeout')
    if (isQuitAndInstallRequested()) {
      shutdownLog.error('cleanup timed out; installing downloaded update anyway')
      performQuitAndInstall()
    } else {
      shutdownLog.error('timeout - forcing exit')
      app.exit(1)
    }
  }, 5000) // 5 second timeout

  // Flush pending saves from all renderer windows before closing vault
  flushAllWindows()
    .then(() => createCloseSnapshots())
    .then(() => {
      shutdownLog.info('stopping snooze scheduler...')
      stopSnoozeScheduler()

      shutdownLog.info('stopping reminder scheduler...')
      stopReminderScheduler()

      shutdownLog.info('stopping inbox review scheduler...')
      stopInboxReviewScheduler()

      shutdownLog.info('stopping Google Calendar sync runner...')
      stopGoogleCalendarSyncRunner()
    })
    .then(() => {
      shutdownLog.info('stopping capture server...')
      return stopCaptureServer()
    })
    .then(() => {
      shutdownLog.info('stopping AI inline chat server...')
      return stopChatServer()
    })
    .then(() => {
      shutdownLog.info('stopping voice transcription utility...')
      return stopVoiceModel()
    })
    .then(() => {
      shutdownLog.info('stopping image processing utility...')
      return stopImageProcessing()
    })
    .then(() => {
      // Terminate the embeddings utilityProcess explicitly. On Windows it runs
      // as the app binary (Memrynote.exe); if left to its 30s idle self-exit it
      // can outlive the NSIS CHECK_APP_RUNNING window and block the update
      // install ("MemryNote cannot be closed", #805).
      shutdownLog.info('stopping embeddings utility...')
      return stopEmbeddingModel()
    })
    .then(async () => {
      shutdownLog.info('stopping active heartbeat...')
      stopActiveHeartbeat()
      shutdownLog.info('flushing log-ship transport...')
      await getLogShip()?.dispose()
      shutdownLog.info('flushing telemetry runtime...')
      return disposeTelemetryRuntime()
    })
    .then(() => {
      // When installing an update, skip the final CRDT snapshot push: it's an
      // unbounded network round-trip that can stall shutdown for tens of seconds
      // (and the installer is about to swap the binary anyway). The next launch
      // syncs. A normal quit still pushes so nothing is left unsynced.
      if (isQuitAndInstallRequested()) {
        shutdownLog.info('stopping sync runtime (skip final push for update)...')
        return stopSyncRuntime({ skipFinalSync: true })
      }
      shutdownLog.info('stopping sync runtime...')
      return stopSyncRuntime()
    })
    .then(() => {
      shutdownLog.info('closing vault and stopping watcher...')
      return closeVault()
    })
    .then(() => {
      shutdownLog.info('cleanup complete')
      clearTimeout(shutdownTimeout)
      // Cleanup finished: this shutdown is clean, so the next launch must not
      // report app_crashed. The timeout/failed-cleanup paths deliberately keep
      // the marker — a hung or failed shutdown IS an unclean exit worth seeing.
      clearCrashMarker()
      if (isQuitAndInstallRequested()) {
        // Cleanup is done; hand off to Squirrel/NSIS to install + relaunch.
        // The re-entrant before-quit returns early (isShuttingDown), so the
        // install-driven quit is no longer cancelled by preventDefault.
        shutdownLog.info('installing downloaded update and relaunching')
        performQuitAndInstall()
      } else {
        // Quit (not app.exit) so the `quit` event fires. app.exit() bypasses it,
        // which silently disables electron-updater's autoInstallOnAppQuit — a
        // downloaded-but-not-yet-installed update would never apply on a normal
        // quit. The re-entrant before-quit returns early (isShuttingDown), so
        // this completes the quit instead of re-running cleanup.
        app.quit()
      }
    })
    .catch((error) => {
      shutdownLog.error('error during cleanup:', error)
      clearTimeout(shutdownTimeout)
      // Same as the timeout path: the exit below outruns any log flush, so the
      // marker reports this shutdown failure on the next launch.
      markShutdownFailure('cleanup_error')
      // Same as the timeout path: a pending install must survive a failed
      // cleanup, otherwise the hard exit drops the update and the loop returns.
      if (isQuitAndInstallRequested()) {
        shutdownLog.error('cleanup failed; installing downloaded update anyway')
        performQuitAndInstall()
      } else {
        app.exit(1)
      }
    })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (headlessCliArgs) return

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Unregister all global shortcuts when the app is about to quit
app.on('will-quit', () => {
  if (headlessCliArgs) return

  globalShortcut.unregisterAll()
  quickCaptureLog.info('global shortcuts unregistered')
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
