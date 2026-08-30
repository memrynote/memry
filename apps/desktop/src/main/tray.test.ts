import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TrayStub {
  icon: unknown
  handlers: Map<string, () => void>
  setToolTip: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  popUpContextMenu: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

interface MenuTemplateItem {
  label?: string
  type?: string
  click?: () => void
}

const mocks = vi.hoisted(() => ({
  trays: [] as TrayStub[],
  trayThrows: false,
  templates: [] as MenuTemplateItem[][],
  appQuit: vi.fn(),
  appListeners: new Map<string, Array<() => void>>()
}))

vi.mock('electron', () => {
  class Tray {
    constructor(icon: unknown) {
      if (mocks.trayThrows) throw new Error('no status notifier host')
      const stub: TrayStub = {
        icon,
        handlers: new Map(),
        setToolTip: vi.fn(),
        setContextMenu: vi.fn(),
        popUpContextMenu: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn()
      }
      stub.on.mockImplementation((event: string, handler: () => void) => {
        stub.handlers.set(event, handler)
        return stub
      })
      mocks.trays.push(stub)
      return stub as unknown as Tray
    }
  }

  return {
    app: {
      name: 'MemryNote',
      quit: mocks.appQuit,
      on: (event: string, handler: () => void) => {
        const existing = mocks.appListeners.get(event) ?? []
        existing.push(handler)
        mocks.appListeners.set(event, existing)
      }
    },
    Menu: {
      buildFromTemplate: (template: MenuTemplateItem[]) => {
        mocks.templates.push(template)
        return { template }
      }
    },
    nativeImage: {
      createFromDataURL: (url: string) => ({
        url,
        resize: vi.fn().mockReturnThis(),
        setTemplateImage: vi.fn()
      })
    },
    Tray
  }
})

vi.mock('./lib/main-i18n', () => ({
  getMainI18n: () => ({ getFixedT: () => (key: string) => key })
}))

import {
  __resetTrayForTests,
  applyTraySetting,
  handleMainWindowClose,
  initTray,
  shouldHideOnClose,
  showMainWindow
} from './tray'

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    setSkipTaskbar: vi.fn()
  }
}

function createCloseEvent() {
  return { preventDefault: vi.fn() } as unknown as Electron.Event & {
    preventDefault: ReturnType<typeof vi.fn>
  }
}

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function emitBeforeQuit(): void {
  for (const handler of mocks.appListeners.get('before-quit') ?? []) handler()
}

function lastTemplate(): MenuTemplateItem[] {
  const template = mocks.templates.at(-1)
  if (!template) throw new Error('no context menu was built')
  return template
}

let window: ReturnType<typeof createWindow>

beforeEach(() => {
  mocks.trays.length = 0
  mocks.templates.length = 0
  mocks.trayThrows = false
  mocks.appQuit.mockClear()
  mocks.appListeners.clear()
  __resetTrayForTests()
  window = createWindow()
  setPlatform('win32')
  initTray({ getMainWindow: () => window as unknown as Electron.BrowserWindow })
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe('applyTraySetting', () => {
  it('#given the setting is off #when it is turned on #then one tray is created', () => {
    applyTraySetting(true)

    expect(mocks.trays).toHaveLength(1)
    expect(mocks.trays[0].setToolTip).toHaveBeenCalledWith('MemryNote')
  })

  it('#given a tray exists #when the same value is applied again #then no second tray is created', () => {
    applyTraySetting(true)
    applyTraySetting(true)

    expect(mocks.trays).toHaveLength(1)
  })

  it('#given a tray exists #when the setting is turned off #then the tray is destroyed and the window comes back', () => {
    applyTraySetting(true)
    applyTraySetting(false)

    expect(mocks.trays[0].destroy).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.setSkipTaskbar).toHaveBeenLastCalledWith(false)
    expect(shouldHideOnClose()).toBe(false)
  })

  it('#given no tray exists #when the setting is turned off #then the window is not disturbed', () => {
    applyTraySetting(false)

    expect(window.show).not.toHaveBeenCalled()
  })

  it('#given the desktop has no tray host #when the setting is turned on #then it degrades instead of throwing', () => {
    mocks.trayThrows = true

    expect(() => applyTraySetting(true)).not.toThrow()
    expect(shouldHideOnClose()).toBe(false)
  })
})

describe('handleMainWindowClose', () => {
  it('#given the setting is on #when the window is closed #then it hides instead of closing', () => {
    applyTraySetting(true)
    const event = createCloseEvent()

    handleMainWindowClose(event, window as unknown as Electron.BrowserWindow)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(window.hide).toHaveBeenCalledTimes(1)
  })

  it('#given the setting is off #when the window is closed #then the close proceeds', () => {
    const event = createCloseEvent()

    handleMainWindowClose(event, window as unknown as Electron.BrowserWindow)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('#given tray creation failed #when the window is closed #then the close proceeds', () => {
    mocks.trayThrows = true
    applyTraySetting(true)
    const event = createCloseEvent()

    handleMainWindowClose(event, window as unknown as Electron.BrowserWindow)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('#given the app is quitting #when the window is closed #then the close is no longer intercepted', () => {
    applyTraySetting(true)
    emitBeforeQuit()
    const event = createCloseEvent()

    handleMainWindowClose(event, window as unknown as Electron.BrowserWindow)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('#given windows #when the window hides to tray #then it leaves the taskbar and returns on restore', () => {
    applyTraySetting(true)

    handleMainWindowClose(createCloseEvent(), window as unknown as Electron.BrowserWindow)
    expect(window.setSkipTaskbar).toHaveBeenLastCalledWith(true)

    showMainWindow()
    expect(window.setSkipTaskbar).toHaveBeenLastCalledWith(false)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('#given macOS #when the window hides to tray #then the taskbar flag is left alone', () => {
    setPlatform('darwin')
    applyTraySetting(true)

    handleMainWindowClose(createCloseEvent(), window as unknown as Electron.BrowserWindow)

    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(window.setSkipTaskbar).not.toHaveBeenCalled()
  })
})

describe('tray context menu', () => {
  it('#given a tray exists #when Show is chosen #then the window is restored', () => {
    applyTraySetting(true)
    window.isMinimized.mockReturnValue(true)

    lastTemplate()
      .find((item) => item.label === 'tray.show')
      ?.click?.()

    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.restore).toHaveBeenCalledTimes(1)
  })

  it('#given a tray exists #when Quit is chosen #then the app quits and the close is not intercepted', () => {
    applyTraySetting(true)

    lastTemplate()
      .find((item) => item.label === 'app.exit')
      ?.click?.()

    expect(mocks.appQuit).toHaveBeenCalledTimes(1)
    expect(shouldHideOnClose()).toBe(false)
  })
})

describe('platform wiring', () => {
  it('#given windows #when the tray is created #then it has a context menu and a left-click restore', () => {
    applyTraySetting(true)

    expect(mocks.trays[0].setContextMenu).toHaveBeenCalledTimes(1)
    mocks.trays[0].handlers.get('click')?.()
    expect(window.show).toHaveBeenCalledTimes(1)
  })

  it('#given macOS #when the tray is created #then left-click restores and right-click pops the menu', () => {
    setPlatform('darwin')
    applyTraySetting(true)

    expect(mocks.trays[0].setContextMenu).not.toHaveBeenCalled()
    mocks.trays[0].handlers.get('click')?.()
    expect(window.show).toHaveBeenCalledTimes(1)
    mocks.trays[0].handlers.get('right-click')?.()
    expect(mocks.trays[0].popUpContextMenu).toHaveBeenCalledTimes(1)
  })

  it('#given linux #when the tray is created #then only the context menu is wired', () => {
    setPlatform('linux')
    applyTraySetting(true)

    expect(mocks.trays[0].setContextMenu).toHaveBeenCalledTimes(1)
    expect(mocks.trays[0].handlers.size).toBe(0)
  })
})
