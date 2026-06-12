import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  globalShortcut,
  clipboard,
  screen,
  session,
  nativeImage,
  Menu,
  MenuItem
} from 'electron'
import { createHash } from 'node:crypto'
import { join, resolve, normalize } from 'path'
import { homedir } from 'node:os'
import { existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { lookup as mimeLookup } from 'mime-types'
import { config } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'
import { registerAllHandlers } from './ipc'
import { applyGlobalCaptureShortcut } from './ipc/settings-handlers'
import {
  autoOpenLastVault,
  closeVault,
  getStatus as getVaultStatus,
  onVaultStatusChanged
} from './vault'
import { readPreferences } from './vault/vault-preferences'
import { getCurrentVaultPath, getStoredLocale } from './store'
import { startSnoozeScheduler, stopSnoozeScheduler, checkDueItemsOnStartup } from './inbox/snooze'
import { stopVoiceModel } from './inbox/voice-model'
import { stopImageProcessing } from './image-processing/bridge'
import { startReminderScheduler, stopReminderScheduler } from './lib/reminders'
import { disposeTelemetryRuntime, initializeTelemetryRuntime } from './telemetry/runtime'
import { getTelemetryAuthState, getTelemetrySyncState } from './telemetry/state'
import {
  trackLaunchPhase,
  trackMainError,
  trackMainLog,
  startActiveHeartbeat,
  stopActiveHeartbeat
} from './telemetry/diagnostics'
import { trackMainEvent } from './telemetry/track'
import {
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner,
  triggerGoogleCalendarSyncNow
} from './calendar/google/sync-service'
import { log, createLogger, disableConsoleTransport } from './lib/logger'
import { isAllowedExternalUrl } from './lib/external-url'
import { registerTestHooks } from './test-hooks'
import {
  computeSpkiHashFromPem,
  isPinningDisabled,
  getPinnedCertificateHashes,
  getPinnedCertificateHashesForHostname
} from './sync/certificate-pinning'
import { getCrdtProvider } from './sync/crdt-provider'
import { stopSyncRuntime } from './sync/runtime'
import { getValidAccessToken } from './sync/token-manager'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from './database/client'
import { toAbsolutePath, createSnapshot } from './vault/notes'
import { safeRead } from './vault/file-ops'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { initializeUpdater } from './updater'
import { buildAppMenu, buildEditableTextContextMenu } from './menu'
import { setMainI18n } from './lib/main-i18n'
import {
  sendAppNavigationCommand,
  sendAppNavigationKeyboardCommand,
  sendAppNavigationSwipeCommand,
  type AppNavigationSwipeDirection
} from './app-navigation-command'
import { getHeadlessCliArgs, runHeadlessCli } from './cli/headless'
import { reconcileBillingAndSync, startBillingCheckout } from './billing/paddle-billing'

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
const launchStartedAt = Date.now()

let mainDiagnosticsRegistered = false

function registerMainDiagnostics(): void {
  if (mainDiagnosticsRegistered) return
  mainDiagnosticsRegistered = true

  process.on('uncaughtException', (error) => {
    trackMainError('main_process', 'uncaught_exception', error)
  })

  process.on('unhandledRejection', (reason) => {
    trackMainError('main_process', 'unhandled_rejection', reason)
  })

  app.on('render-process-gone', (_event, _webContents, details) => {
    trackMainLog('error', {
      scope: 'Electron',
      action: 'render_process_gone',
      errorCode: details.reason
    })
  })

  app.on('child-process-gone', (_event, details) => {
    trackMainLog('error', {
      scope: 'Electron',
      action: 'child_process_gone',
      errorCode: details.type
    })
  })
}
if (deviceId) {
  process.env.MEMRY_DEVICE = deviceId
  app.name = `memry-${deviceId}`
  const deviceUserData = `${app.getPath('userData')}-${deviceId}`
  app.setPath('userData', deviceUserData)
}

const mainLog = createLogger('Main')
const configLog = createLogger('Config')
const quickCaptureLog = createLogger('QuickCapture')
const shutdownLog = createLogger('Shutdown')
const deepLinkLog = createLogger('DeepLink')
const headlessCliArgs = getHeadlessCliArgs(process.argv)

let mainI18n: I18nInstance

if (headlessCliArgs) {
  disableConsoleTransport()
  void runHeadlessCli(headlessCliArgs).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
}

async function bootI18n(): Promise<I18nInstance> {
  let initialLocale: Locale = getStoredLocale() ?? FALLBACK_LOCALE

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
// .env.<environment> files; packaged apps receive Resources/.env.
const envPath = app.isPackaged
  ? join(process.resourcesPath, '.env')
  : join(app.getAppPath(), `.env.${resolveMemryEnvironment()}`)

const envResult = config({ path: envPath, quiet: true })
if (envResult.error) {
  // Try loading from current working directory as fallback
  config({ quiet: true })
}

// Register custom protocol as privileged before app is ready
// This enables streaming support for audio/video elements
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'memry-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
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
    certPinLog.error('No valid certificate pins available — session pinning disabled (TLS-only)')
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
  size: typeof DEFAULT_MAIN_WINDOW_SIZE | typeof VAULT_PICKER_WINDOW_SIZE
): void {
  if (window.isDestroyed()) return

  const [currentWidth, currentHeight] = window.getSize()
  if (currentWidth === size.width && currentHeight === size.height) return

  if (window.isMaximized()) {
    window.unmaximize()
  }
  window.setSize(size.width, size.height)
}

function createWindow(): void {
  const initialSize = getInitialMainWindowSize()

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
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
  trackLaunchPhase('window_created', Date.now() - launchStartedAt)

  const unsubscribeVaultStatus = onVaultStatusChanged((status) => {
    resizeWindowIfNeeded(
      mainWindow,
      status.isOpen ? DEFAULT_MAIN_WINDOW_SIZE : VAULT_PICKER_WINDOW_SIZE
    )
  })
  mainWindow.on('closed', unsubscribeVaultStatus)

  mainWindow.on('ready-to-show', () => {
    // Zoom out once (equivalent to Cmd+-)
    // mainWindow.webContents.setZoomLevel(-0.8)
    mainWindow.show()
    trackLaunchPhase('window_ready_to_show', Date.now() - launchStartedAt)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    trackLaunchPhase('window_did_finish_load', Date.now() - launchStartedAt)
  })

  mainWindow.on('focus', () => {
    triggerGoogleCalendarSyncNow('window-focus')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
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

const pendingOAuthStates = new Map<string, number>()

export const registerOAuthState = (state: string): void => {
  pendingOAuthStates.set(state, Date.now())
  setTimeout(() => pendingOAuthStates.delete(state), 10 * 60 * 1000)
}

function openAccountSettings(mainWindow: BrowserWindow): void {
  mainWindow.webContents.send(SettingsChannels.events.OPEN_SECTION, 'account')
}

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'memry:') return

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return

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
void app.whenReady().then(async () => {
  if (headlessCliArgs) return
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

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Register memry:// deep link protocol for OAuth callbacks (T041e)
  if (!app.isDefaultProtocolClient('memry')) {
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

    const isAllowed = allowedDirs.some((dir) => filePath.startsWith(dir + '/') || filePath === dir)
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
    } catch {
      // Return 404 for any errors
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
  })

  mainI18n = await bootI18n()
  setMainI18n(mainI18n)
  Menu.setApplicationMenu(buildAppMenu(mainI18n))

  // Initialize telemetry runtime before handlers so registerTelemetryHandlers
  // can resolve `getTelemetryRuntime()` to the live instance.
  initializeTelemetryRuntime({
    appVersion: app.getVersion(),
    locale: app.getLocale(),
    authStateProvider: getTelemetryAuthState,
    syncStateProvider: getTelemetrySyncState,
    accessTokenProvider: () => getValidAccessToken()
  })
  registerMainDiagnostics()
  startActiveHeartbeat(() => BrowserWindow.getFocusedWindow() !== null)

  app.on('browser-window-blur', () => {
    setImmediate(() => {
      if (BrowserWindow.getFocusedWindow() === null) {
        trackMainEvent('app_backgrounded', { surface: 'app', action: 'backgrounded' })
      }
    })
  })

  trackLaunchPhase('app_ready', Date.now() - launchStartedAt)

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
      .catch((err) => mainLog.error('Window close flush failed:', err))
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

  // Register global shortcut for quick capture from keyboard settings (fallback: hardcoded default)
  const globalCaptureResult = applyGlobalCaptureShortcut()
  quickCaptureShortcutRegistration.configuredRegistered = globalCaptureResult.registered
  quickCaptureShortcutRegistration.registered = globalCaptureResult.registered
  if (!globalCaptureResult.registered) {
    registerQuickCaptureShortcut()
  }
  registerQuickCaptureTestHooks()

  // Configure CSP and cert pinning before the window loads
  configureCsp()
  configureCertificatePinning()

  if (process.platform === 'darwin' && !app.isPackaged) {
    const iconPath = join(__dirname, '../../build/icon.png')
    app.dock?.setIcon(nativeImage.createFromPath(iconPath))
  }

  createWindow()
  initializeUpdater()

  // Open the last vault and start schedulers concurrently with renderer load.
  // The renderer subscribes to vault status events and updates automatically.
  void autoOpenLastVault()
    .then(async () => {
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
      void startGoogleCalendarSyncRunner().catch((error) => {
        mainLog.warn('Google Calendar sync runner failed to start:', error)
        trackMainLog('warn', {
          scope: 'Startup',
          action: 'google_calendar_sync_start_failed',
          errorCode: error instanceof Error ? error.name : 'UnknownError'
        })
      })
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
  const registered = globalShortcut.register(QUICK_CAPTURE_SHORTCUT, handleQuickCaptureShortcut)

  quickCaptureShortcutRegistration.fallbackAttempted = true
  quickCaptureShortcutRegistration.fallbackRegistered = registered
  quickCaptureShortcutRegistration.registered =
    quickCaptureShortcutRegistration.configuredRegistered || registered

  if (!registered) {
    quickCaptureLog.warn(
      `failed to register global shortcut: ${QUICK_CAPTURE_SHORTCUT}. It may be in use by another application.`
    )
  }
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

function flushWindow(win: BrowserWindow, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed() || !win.webContents) {
      shutdownLog.info('flushWindow: window already destroyed', win.id)
      resolve()
      return
    }

    shutdownLog.info('flushWindow: requesting flush from window', win.id)

    const timer = setTimeout(() => {
      shutdownLog.warn('flushWindow: timeout for window', win.id)
      resolve()
    }, timeoutMs)

    const channel = 'app:flush-done'
    const handler = (): void => {
      shutdownLog.info('flushWindow: flush-done received from window', win.id)
      clearTimeout(timer)
      ipcMain.removeListener(channel, handler)
      resolve()
    }

    ipcMain.on(channel, handler)
    win.webContents.send('app:request-flush')
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

  shutdownLog.info('starting graceful shutdown...')

  // Set timeout to force exit if shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    shutdownLog.error('timeout - forcing exit')
    app.exit(1)
  }, 5000) // 5 second timeout

  // Flush pending saves from all renderer windows before closing vault
  flushAllWindows()
    .then(() => createCloseSnapshots())
    .then(() => {
      shutdownLog.info('stopping snooze scheduler...')
      stopSnoozeScheduler()

      shutdownLog.info('stopping reminder scheduler...')
      stopReminderScheduler()

      shutdownLog.info('stopping Google Calendar sync runner...')
      stopGoogleCalendarSyncRunner()
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
      shutdownLog.info('stopping active heartbeat...')
      stopActiveHeartbeat()
      shutdownLog.info('flushing telemetry runtime...')
      return disposeTelemetryRuntime()
    })
    .then(() => {
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
      app.exit(0)
    })
    .catch((error) => {
      shutdownLog.error('error during cleanup:', error)
      clearTimeout(shutdownTimeout)
      app.exit(1)
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
