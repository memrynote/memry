import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({
  stored: 1 as number,
  windows: [] as unknown[],
  broadcast: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mocks.windows
  }
}))

vi.mock('./lib/window-broadcast', () => ({
  broadcastToAllWindows: mocks.broadcast
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('./store', () => ({
  getUiZoomFactor: () => mocks.stored,
  setUiZoomFactor: (factor: number) => {
    mocks.stored = factor
  }
}))

import { applyZoomToWindow, getZoomFactor, setZoomFactor } from './window-zoom'

function fakeWindow(): BrowserWindow & {
  webContents: { setZoomFactor: ReturnType<typeof vi.fn> }
} {
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      setZoomFactor: vi.fn()
    }
  }
  return win as unknown as BrowserWindow & {
    webContents: { setZoomFactor: ReturnType<typeof vi.fn> }
  }
}

describe('window zoom', () => {
  beforeEach(() => {
    mocks.stored = 1
    mocks.windows = []
    mocks.broadcast.mockClear()
  })

  it('#given a window opts in #then it is put at the persisted factor', () => {
    mocks.stored = 1.5
    const win = fakeWindow()

    applyZoomToWindow(win)

    expect(win.webContents.setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('#given a factor off the ladder #then it is snapped before being persisted', () => {
    setZoomFactor(1.28)

    expect(getZoomFactor()).toBe(1.3)
  })

  it('#given a factor above the ladder #then it clamps to the highest rung', () => {
    expect(setZoomFactor(99)).toBe(2)
    expect(getZoomFactor()).toBe(2)
  })

  it('#given a factor below the ladder #then it clamps to the lowest rung', () => {
    expect(setZoomFactor(0.01)).toBe(0.75)
  })

  it('#given several windows opted in #then a change reaches every one of them', () => {
    const a = fakeWindow()
    const b = fakeWindow()
    mocks.windows = [a, b]
    applyZoomToWindow(a)
    applyZoomToWindow(b)
    a.webContents.setZoomFactor.mockClear()
    b.webContents.setZoomFactor.mockClear()

    setZoomFactor(1.5)

    expect(a.webContents.setZoomFactor).toHaveBeenCalledWith(1.5)
    expect(b.webContents.setZoomFactor).toHaveBeenCalledWith(1.5)
  })

  it('#given a window never opted in #then a change leaves it alone', () => {
    const chrome = fakeWindow()
    const splash = fakeWindow()
    mocks.windows = [chrome, splash]
    applyZoomToWindow(chrome)
    chrome.webContents.setZoomFactor.mockClear()

    setZoomFactor(1.75)

    expect(chrome.webContents.setZoomFactor).toHaveBeenCalledWith(1.75)
    expect(splash.webContents.setZoomFactor).not.toHaveBeenCalled()
  })

  it('#given a zoom change #then renderers are told the applied factor', () => {
    setZoomFactor(1.15)

    expect(mocks.broadcast).toHaveBeenCalledWith('ui-zoom:changed', { factor: 1.15 })
  })

  it('#given a zoomed app #when reset to 1 #then it returns to actual size', () => {
    const win = fakeWindow()
    mocks.windows = [win]
    applyZoomToWindow(win)
    setZoomFactor(1.75)

    expect(setZoomFactor(1)).toBe(1)
    expect(win.webContents.setZoomFactor).toHaveBeenLastCalledWith(1)
  })

  it('#given a destroyed window opted in earlier #then applying does not throw', () => {
    const dead = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true, setZoomFactor: vi.fn() }
    } as unknown as BrowserWindow
    mocks.windows = [dead]
    applyZoomToWindow(dead)

    expect(() => setZoomFactor(1.5)).not.toThrow()
  })
})
