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
  Menu,
  MenuItem
} from 'electron'
import { join } from 'path'
import { homedir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { config } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllHandlers } from './ipc'
import { autoOpenLastVault, closeVault } from './vault'
import { startSnoozeScheduler, stopSnoozeScheduler, checkDueItemsOnStartup } from './inbox/snooze'
import { startReminderScheduler, stopReminderScheduler } from './lib/reminders'
import { log, createLogger } from './lib/logger'

if (process.type === 'browser') {
  log.initialize()
}

const deviceId = process.env.MEMRY_DEVICE
if (deviceId) {
  const deviceUserData = `${app.getPath('userData')}-${deviceId}`
  app.setPath('userData', deviceUserData)
}

const mainLog = createLogger('Main')
const configLog = createLogger('Config')
const quickCaptureLog = createLogger('QuickCapture')
const shutdownLog = createLogger('Shutdown')
const deepLinkLog = createLogger('DeepLink')

// Load .env file from project root (must be before any env access)
// In development, load from project root; in production, from app resources
const envPath = app.isPackaged
  ? join(process.resourcesPath, '.env')
  : join(app.getAppPath(), '.env')

const envResult = config({ path: envPath })
if (envResult.error) {
  // Try loading from current working directory as fallback
  config()
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
  /** OpenAI API key for transcription and AI suggestions */
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
  // OpenAI API Key - required for voice transcription and AI suggestions
  envConfig.openaiApiKey = process.env.OPENAI_API_KEY

  if (!envConfig.openaiApiKey) {
    configLog.warn(
      'OPENAI_API_KEY not set. Voice transcription and AI suggestions will be disabled.'
    )
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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1550,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // Hide native traffic lights - we use custom ones
          trafficLightPosition: { x: -100, y: -100 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // Zoom out once (equivalent to Cmd+-)
    // mainWindow.webContents.setZoomLevel(-0.8)
    mainWindow.show()
    mainWindow.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
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

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'memry:') return

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return

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

// Windows/Linux: deep links arrive via second-instance event
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

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(async () => {
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

    // Check if file exists before fetching to avoid noisy errors
    const { existsSync } = await import('fs')
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
      const { statSync, createReadStream } = await import('fs')
      const { lookup } = await import('mime-types')
      const stats = statSync(filePath)
      const fileSize = stats.size
      const mimeType = lookup(filePath) || 'application/octet-stream'

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
    win?.close()
  })

  // Quick Capture IPC handlers
  ipcMain.on('quick-capture:close', () => {
    closeQuickCaptureWindow()
  })

  ipcMain.handle('quick-capture:get-clipboard', () => {
    return clipboard.readText()
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

  // Register all IPC handlers (vault, notes, tasks, search)
  registerAllHandlers()

  // Register global shortcut for quick capture (Cmd+Shift+Space)
  registerQuickCaptureShortcut()

  // Auto-open the last vault if one was previously open
  await autoOpenLastVault()

  // Start the snooze scheduler for inbox items
  // This checks for due items on startup and then every minute
  try {
    checkDueItemsOnStartup()
    startSnoozeScheduler()
  } catch (error) {
    // Snooze scheduler is non-critical - log and continue
    mainLog.warn('snooze scheduler failed to start:', error)
  }

  // Start the reminder scheduler for notes/journal/highlights
  // This checks for due reminders on startup and then every minute
  try {
    startReminderScheduler()
  } catch (error) {
    // Reminder scheduler is non-critical - log and continue
    mainLog.warn('reminder scheduler failed to start:', error)
  }

  createWindow()

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
  const windowHeight = 200

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
      sandbox: false
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
function registerQuickCaptureShortcut(): void {
  const shortcut = 'CommandOrControl+Shift+Space'

  const registered = globalShortcut.register(shortcut, () => {
    showQuickCaptureWindow()
  })

  if (!registered) {
    quickCaptureLog.warn(
      `failed to register global shortcut: ${shortcut}. It may be in use by another application.`
    )
  }
}

// ============================================================================
// Shutdown Handling
// ============================================================================

// Track if shutdown is already in progress to prevent duplicate handling
let isShuttingDown = false

// Graceful shutdown: close vault and databases before quitting
app.on('before-quit', (event) => {
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

  // Stop the snooze scheduler
  shutdownLog.info('stopping snooze scheduler...')
  stopSnoozeScheduler()

  // Stop the reminder scheduler
  shutdownLog.info('stopping reminder scheduler...')
  stopReminderScheduler()

  shutdownLog.info('closing vault and stopping watcher...')
  closeVault()
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Unregister all global shortcuts when the app is about to quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  quickCaptureLog.info('global shortcuts unregistered')
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
