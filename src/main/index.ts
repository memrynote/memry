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
    console.warn(
      '[Config] OPENAI_API_KEY not set. Voice transcription and AI suggestions will be disabled.'
    )
  } else {
    console.log('[Config] OpenAI API key loaded successfully')
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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
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
            console.log(`Added Extension: ${extension.name}`)
          } else {
            console.log('React DevTools: session.extensions API not available')
          }
        }
      } else {
        console.log('React DevTools not found. Install it in Chrome to enable.')
      }
    } catch (err) {
      // Extension loading can fail for various reasons (version mismatch, sandbox issues)
      // This is non-critical for development
      console.log('Failed to load React DevTools:', err instanceof Error ? err.message : err)
    }
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Register custom protocol for serving local attachment files
  // This allows secure access to vault files from the renderer process
  protocol.handle('memry-file', async (request) => {
    // URL format: memry-file:///absolute/path/to/file
    const url = new URL(request.url)
    // The pathname is URL-encoded, need to decode it
    let filePath = decodeURIComponent(url.pathname)
    // On Windows, remove the leading slash from /C:/path/to/file
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1)
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
  ipcMain.on('ping', () => console.log('pong'))

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
    console.warn('[Snooze] Failed to start scheduler:', error)
  }

  // Start the reminder scheduler for notes/journal/highlights
  // This checks for due reminders on startup and then every minute
  try {
    startReminderScheduler()
  } catch (error) {
    // Reminder scheduler is non-critical - log and continue
    console.warn('[Reminders] Failed to start scheduler:', error)
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
    console.log('[QuickCapture] Loading URL:', url)
    quickCaptureWindow.loadURL(url)
  } else {
    // In production, load the HTML file with hash
    const filePath = join(__dirname, '../renderer/index.html')
    console.log('[QuickCapture] Loading file:', filePath)
    quickCaptureWindow.loadFile(filePath, {
      hash: 'quick-capture'
    })
  }

  // Handle load failures
  quickCaptureWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[QuickCapture] Failed to load:', errorCode, errorDescription)
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
    console.warn(`[QuickCapture] Failed to register global shortcut: ${shortcut}. It may be in use by another application.`)
  }
}

// ============================================================================
// Shutdown Handling
// ============================================================================

// Track if shutdown is already in progress to prevent duplicate handling
let isShuttingDown = false

// Graceful shutdown: close vault and databases before quitting
app.on('before-quit', async (event) => {
  // Prevent duplicate shutdown handling
  if (isShuttingDown) return
  isShuttingDown = true

  event.preventDefault()

  console.log('[Shutdown] Starting graceful shutdown...')

  // Set timeout to force exit if shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    console.error('[Shutdown] Timeout - forcing exit')
    app.exit(1)
  }, 5000) // 5 second timeout

  try {
    // Stop the snooze scheduler
    console.log('[Shutdown] Stopping snooze scheduler...')
    stopSnoozeScheduler()

    // Stop the reminder scheduler
    console.log('[Shutdown] Stopping reminder scheduler...')
    stopReminderScheduler()

    console.log('[Shutdown] Closing vault and stopping watcher...')
    await closeVault() // This also closes databases
    console.log('[Shutdown] Cleanup complete')
    clearTimeout(shutdownTimeout)
    app.exit(0)
  } catch (error) {
    console.error('[Shutdown] Error during cleanup:', error)
    clearTimeout(shutdownTimeout)
    app.exit(1)
  }
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
  console.log('[QuickCapture] Global shortcuts unregistered')
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
