/**
 * Window broadcast tests
 *
 * Regression: emit fan-outs iterated BrowserWindow.getAllWindows() and called
 * webContents.send() with no isDestroyed() guard. A destroyed short-lived
 * window (splash, quick-capture, print/export) made the emit throw — inside
 * sync item handlers that throw propagates out of ctx.emit within
 * ctx.db.transaction and rolls back an applied sync item.
 *
 * @module lib/window-broadcast.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const windows: unknown[] = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => windows)
  }
}))

import { broadcastToAllWindows } from './window-broadcast'

function makeLiveWindow() {
  const send = vi.fn()
  return {
    win: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    },
    send
  }
}

// Real Electron throws 'Object has been destroyed' on any access to a
// destroyed window's webContents.
function makeDestroyedWindow() {
  return {
    isDestroyed: () => true,
    get webContents(): never {
      throw new Error('Object has been destroyed')
    }
  }
}

function makeDeadContentsWindow() {
  const send = vi.fn(() => {
    throw new Error('Object has been destroyed')
  })
  return {
    win: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, send }
    },
    send
  }
}

describe('broadcastToAllWindows', () => {
  beforeEach(() => {
    windows.length = 0
  })

  it('sends the payload to every live window', () => {
    const a = makeLiveWindow()
    const b = makeLiveWindow()
    windows.push(a.win, b.win)

    broadcastToAllWindows('sync:event', { id: 1 })

    expect(a.send).toHaveBeenCalledWith('sync:event', { id: 1 })
    expect(b.send).toHaveBeenCalledWith('sync:event', { id: 1 })
  })

  it('skips a destroyed window and still delivers to the remaining windows', () => {
    const before = makeLiveWindow()
    const after = makeLiveWindow()
    windows.push(before.win, makeDestroyedWindow(), after.win)

    expect(() => broadcastToAllWindows('sync:event', { id: 1 })).not.toThrow()

    expect(before.send).toHaveBeenCalledWith('sync:event', { id: 1 })
    expect(after.send).toHaveBeenCalledWith('sync:event', { id: 1 })
  })

  it('skips a window whose webContents is destroyed', () => {
    const live = makeLiveWindow()
    const dead = makeDeadContentsWindow()
    windows.push(dead.win, live.win)

    expect(() => broadcastToAllWindows('sync:event', { id: 1 })).not.toThrow()

    expect(dead.send).not.toHaveBeenCalled()
    expect(live.send).toHaveBeenCalledWith('sync:event', { id: 1 })
  })
})
