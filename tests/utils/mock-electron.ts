/**
 * Electron API mocks for main process testing.
 * Provides mocks for BrowserWindow, shell, dialog, etc.
 */

import { vi } from 'vitest'

// ============================================================================
// BrowserWindow Mock
// ============================================================================

export class MockBrowserWindow {
  id: number
  webContents: MockWebContents
  private _isMaximized = false
  private _isMinimized = false
  private _isVisible = true
  private _isFocused = true
  private _isDestroyed = false
  private _bounds = { x: 0, y: 0, width: 800, height: 600 }

  constructor(_options?: Record<string, unknown>) {
    this.id = Math.floor(Math.random() * 10000)
    this.webContents = new MockWebContents(this.id)
  }

  loadURL = vi.fn().mockResolvedValue(undefined)
  loadFile = vi.fn().mockResolvedValue(undefined)

  show = vi.fn(() => {
    this._isVisible = true
  })
  hide = vi.fn(() => {
    this._isVisible = false
  })
  close = vi.fn(() => {
    this._isDestroyed = true
  })
  destroy = vi.fn(() => {
    this._isDestroyed = true
  })

  focus = vi.fn(() => {
    this._isFocused = true
  })
  blur = vi.fn(() => {
    this._isFocused = false
  })

  minimize = vi.fn(() => {
    this._isMinimized = true
  })
  restore = vi.fn(() => {
    this._isMinimized = false
  })
  maximize = vi.fn(() => {
    this._isMaximized = true
  })
  unmaximize = vi.fn(() => {
    this._isMaximized = false
  })

  isMaximized = vi.fn(() => this._isMaximized)
  isMinimized = vi.fn(() => this._isMinimized)
  isVisible = vi.fn(() => this._isVisible)
  isFocused = vi.fn(() => this._isFocused)
  isDestroyed = vi.fn(() => this._isDestroyed)

  getBounds = vi.fn(() => this._bounds)
  setBounds = vi.fn((bounds: Partial<typeof this._bounds>) => {
    this._bounds = { ...this._bounds, ...bounds }
  })
  setSize = vi.fn((width: number, height: number) => {
    this._bounds.width = width
    this._bounds.height = height
  })
  getSize = vi.fn(() => [this._bounds.width, this._bounds.height])
  setPosition = vi.fn((x: number, y: number) => {
    this._bounds.x = x
    this._bounds.y = y
  })
  getPosition = vi.fn(() => [this._bounds.x, this._bounds.y])

  setTitle = vi.fn()
  getTitle = vi.fn(() => 'Mock Window')

  on = vi.fn().mockReturnThis()
  once = vi.fn().mockReturnThis()
  removeListener = vi.fn().mockReturnThis()
  removeAllListeners = vi.fn().mockReturnThis()

  static getAllWindows = vi.fn(() => [])
  static getFocusedWindow = vi.fn(() => null)
  static fromWebContents = vi.fn(() => null)
  static fromId = vi.fn(() => null)
}

// ============================================================================
// WebContents Mock
// ============================================================================

export class MockWebContents {
  id: number

  constructor(id: number) {
    this.id = id
  }

  send = vi.fn()
  postMessage = vi.fn()

  executeJavaScript = vi.fn().mockResolvedValue(undefined)
  insertCSS = vi.fn().mockResolvedValue('')

  openDevTools = vi.fn()
  closeDevTools = vi.fn()
  isDevToolsOpened = vi.fn(() => false)

  reload = vi.fn()
  reloadIgnoringCache = vi.fn()

  getURL = vi.fn(() => 'about:blank')
  getTitle = vi.fn(() => 'Mock Page')

  on = vi.fn().mockReturnThis()
  once = vi.fn().mockReturnThis()
  removeListener = vi.fn().mockReturnThis()
  removeAllListeners = vi.fn().mockReturnThis()
}

// ============================================================================
// Shell Mock
// ============================================================================

export const mockShell = {
  openExternal: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(''),
  showItemInFolder: vi.fn(),
  trashItem: vi.fn().mockResolvedValue(undefined),
  beep: vi.fn(),
  readShortcutLink: vi.fn(),
  writeShortcutLink: vi.fn()
}

// ============================================================================
// Dialog Mock
// ============================================================================

export const mockDialog = {
  showOpenDialog: vi.fn().mockResolvedValue({
    canceled: false,
    filePaths: ['/mock/selected/path']
  }),
  showOpenDialogSync: vi.fn(() => ['/mock/selected/path']),
  showSaveDialog: vi.fn().mockResolvedValue({
    canceled: false,
    filePath: '/mock/save/path'
  }),
  showSaveDialogSync: vi.fn(() => '/mock/save/path'),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: vi.fn(() => 0),
  showErrorBox: vi.fn(),
  showCertificateTrustDialog: vi.fn().mockResolvedValue(undefined)
}

// ============================================================================
// App Mock
// ============================================================================

export const mockApp = {
  getName: vi.fn(() => 'Memry'),
  getVersion: vi.fn(() => '1.0.0'),
  getPath: vi.fn((name: string) => `/mock/${name}`),
  setPath: vi.fn(),
  getAppPath: vi.fn(() => '/mock/app'),
  isPackaged: false,
  isReady: vi.fn(() => true),
  whenReady: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn(),
  exit: vi.fn(),
  relaunch: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  show: vi.fn(),
  getLocale: vi.fn(() => 'en-US'),
  on: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  removeListener: vi.fn().mockReturnThis()
}

// ============================================================================
// Notification Mock
// ============================================================================

export class MockNotification {
  title: string
  body: string

  constructor(options: { title: string; body: string }) {
    this.title = options.title
    this.body = options.body
  }

  show = vi.fn()
  close = vi.fn()

  on = vi.fn().mockReturnThis()
  once = vi.fn().mockReturnThis()

  static isSupported = vi.fn(() => true)
}

// ============================================================================
// Clipboard Mock
// ============================================================================

export const mockClipboard = {
  readText: vi.fn(() => ''),
  writeText: vi.fn(),
  readHTML: vi.fn(() => ''),
  writeHTML: vi.fn(),
  readImage: vi.fn(),
  writeImage: vi.fn(),
  clear: vi.fn()
}

// ============================================================================
// Complete Electron Mock
// ============================================================================

export const mockElectron = {
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  shell: mockShell,
  dialog: mockDialog,
  Notification: MockNotification,
  clipboard: mockClipboard,
  ipcMain: {
    handle: vi.fn(),
    handleOnce: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn()
  },
  ipcRenderer: {
    send: vi.fn(),
    sendSync: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn()
  }
}

/**
 * Install Electron mocks for testing.
 * Call this before importing modules that use Electron.
 */
export function installElectronMocks(): void {
  vi.mock('electron', () => mockElectron)
}

/**
 * Reset all Electron mocks.
 */
export function resetElectronMocks(): void {
  Object.values(mockShell).forEach((fn) => fn.mockClear())
  Object.values(mockDialog).forEach((fn) => fn.mockClear())
  Object.values(mockApp).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      fn.mockClear()
    }
  })
  Object.values(mockClipboard).forEach((fn) => fn.mockClear())
}
