import { app, shell, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { join } from 'path'
import { config } from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerAllHandlers } from './ipc'
import { autoOpenLastVault, closeVault } from './vault'

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

    try {
      // Check if file exists before fetching to avoid noisy errors
      const { existsSync } = await import('fs')
      if (!existsSync(filePath)) {
        // Return empty response for missing files (e.g., null thumbnails)
        return new Response(null, { status: 404, statusText: 'Not Found' })
      }
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

  // Register all IPC handlers (vault, notes, tasks, search)
  registerAllHandlers()

  // Auto-open the last vault if one was previously open
  await autoOpenLastVault()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
