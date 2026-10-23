import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StickyChannels } from '@memry/contracts/sticky-api'

type Handler = (...args: unknown[]) => void

interface FakeWindow {
  options: Record<string, unknown>
  destroyed: boolean
  webContents: Record<'send' | 'on' | 'loadURL' | 'loadFile', ReturnType<typeof vi.fn>>
  [method: string]: unknown
}

const electron = vi.hoisted(() => {
  const windows: FakeWindow[] = []
  function makeWindow(options: Record<string, unknown> = {}) {
    const handlers = new Map<string, Handler>()
    const window = {
      options,
      destroyed: false,
      webContents: { send: vi.fn(), on: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn() },
      on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
      once: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
      show: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      setSize: vi.fn(),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isDestroyed: vi.fn(() => window.destroyed),
      close: vi.fn(() => {
        window.destroyed = true
        handlers.get('closed')?.()
      }),
      destroy: vi.fn(() => {
        window.destroyed = true
        handlers.get('closed')?.()
      }),
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args)
    }
    windows.push(window)
    return window
  }
  const BrowserWindow = Object.assign(
    vi.fn(function BrowserWindow(options: Record<string, unknown>) {
      return makeWindow(options)
    }),
    { getAllWindows: vi.fn(() => windows.filter((w) => !w.destroyed)) }
  )
  return { windows, makeWindow, BrowserWindow, app: { isPackaged: true } }
})
const drafts = vi.hoisted(() => ({ list: [] as Array<{ id: string }> }))
const refreshEdgeTab = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  }
}))
vi.mock('./drafts', () => ({ listStickyDrafts: () => drafts.list }))
vi.mock('./edge-tab', () => ({ refreshEdgeTab }))

import {
  getStickyWindow,
  getStickyWindowSession,
  openStickyTargetInMainWindow,
  resizeStickyWindow,
  showStickyWindow,
  tuckStickyWindow
} from './sticky-window'

describe('sticky window', () => {
  beforeEach(() => {
    getStickyWindow()?.destroy()
    electron.windows.length = 0
    electron.BrowserWindow.mockClear()
    refreshEdgeTab.mockClear()
    electron.app.isPackaged = true
    Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
    drafts.list = []
  })

  it('resumes the latest draft from the shortcut, and focuses rather than reopens', () => {
    drafts.list = [{ id: 'newest' }, { id: 'older' }]

    showStickyWindow()
    const sticky = getStickyWindow()!
    expect(getStickyWindowSession()).toEqual({ draftId: 'newest' })
    expect(sticky.webContents.loadFile).toHaveBeenCalledWith(
      expect.stringContaining('index.html'),
      {
        hash: 'sticky'
      }
    )

    showStickyWindow()
    expect(electron.BrowserWindow).toHaveBeenCalledTimes(1)
    expect(sticky.focus).toHaveBeenCalled()
  })

  it('opens a new sticky when the shortcut fires while the last one is still closing', () => {
    showStickyWindow(null)
    const closing = getStickyWindow()!
    // A real close finishes later; until then the window is not destroyed.
    vi.mocked(closing.close as () => void).mockImplementationOnce(() => {})

    tuckStickyWindow()
    showStickyWindow()

    expect(electron.BrowserWindow).toHaveBeenCalledTimes(2)
    expect(getStickyWindow()).not.toBe(closing)
  })

  it('starts blank when there are no drafts', () => {
    showStickyWindow()
    expect(getStickyWindowSession()).toEqual({ draftId: null })
  })

  it('replaces an open sticky when the edge tab unfolds another draft', () => {
    drafts.list = [{ id: 'a' }, { id: 'b' }]
    showStickyWindow('a')
    const first = getStickyWindow()!

    showStickyWindow('b')

    expect(first.destroy).toHaveBeenCalled()
    expect(getStickyWindowSession()).toEqual({ draftId: 'b' })
    expect(getStickyWindow()).not.toBe(first)
  })

  it('loads the dev server route and logs load failures without throwing', () => {
    electron.app.isPackaged = false
    Reflect.set(process.env, 'ELECTRON_RENDERER_URL', 'http://localhost:5173/')

    showStickyWindow(null)
    const sticky = electron.windows.at(-1)!

    expect(sticky.webContents.loadURL).toHaveBeenCalledWith('http://localhost:5173/#/sticky')
    const onFail = sticky.webContents.on.mock.calls.find(
      ([e]) => e === 'did-fail-load'
    )?.[1] as Handler
    expect(() => {
      onFail({}, -3, 'aborted')
    }).not.toThrow()
  })

  it('shows once ready, clamps resizes, and lets the edge tab follow tucking', () => {
    showStickyWindow(null)
    const sticky = getStickyWindow()!
    sticky.emit('ready-to-show')
    expect(sticky.show).toHaveBeenCalled()

    resizeStickyWindow(2000)
    expect(sticky.setSize).toHaveBeenLastCalledWith(360, 560)
    resizeStickyWindow(10)
    expect(sticky.setSize).toHaveBeenLastCalledWith(360, 140)

    refreshEdgeTab.mockClear()
    tuckStickyWindow()
    expect(sticky.close).toHaveBeenCalled()
    expect(getStickyWindow()).toBeNull()
    expect(refreshEdgeTab).toHaveBeenCalled()
  })

  it('reveals the app window for a send target, then tucks the sticky', () => {
    const mainWindow = electron.makeWindow()
    mainWindow.isMinimized.mockReturnValueOnce(true)
    mainWindow.isVisible.mockReturnValueOnce(false)

    showStickyWindow(null)
    openStickyTargetInMainWindow({ kind: 'task', targetId: 'task-1' })
    expect(mainWindow.restore).toHaveBeenCalled()
    expect(mainWindow.show).toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      StickyChannels.events.OPEN_TARGET_REQUESTED,
      { kind: 'task', targetId: 'task-1' }
    )
    expect(getStickyWindow()).toBeNull()
  })
})
