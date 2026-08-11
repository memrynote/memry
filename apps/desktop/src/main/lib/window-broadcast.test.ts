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

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('./logger', () => ({ createLogger: () => loggerMock }))

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

/**
 * Passes the isDestroyed() guards but blows up on the actual send — the window
 * died in the gap between the check and the delivery.
 */
function makeThrowingWindow() {
  const send = vi.fn(() => {
    throw new Error('Object has been destroyed')
  })
  return {
    win: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    },
    send
  }
}

describe('broadcastToAllWindows', () => {
  beforeEach(() => {
    windows.length = 0
    loggerMock.warn.mockClear()
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

  // A window that dies between the isDestroyed() guard and the send must not
  // take the rest of the fan-out down with it, and must not surface as a throw
  // in a caller that is mid-transaction (#935, #1000).
  it('keeps delivering after a send throws, and does not propagate to the caller', () => {
    const before = makeLiveWindow()
    const throwing = makeThrowingWindow()
    const after = makeLiveWindow()
    windows.push(before.win, throwing.win, after.win)

    expect(() => broadcastToAllWindows('sync:event', { id: 1 })).not.toThrow()

    expect(before.send).toHaveBeenCalledWith('sync:event', { id: 1 })
    expect(after.send).toHaveBeenCalledWith('sync:event', { id: 1 })
  })

  it('logs a failed delivery rather than dropping it silently', () => {
    const throwing = makeThrowingWindow()
    windows.push(throwing.win)

    broadcastToAllWindows('sync:event', { id: 1 })

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to deliver sync:event to a window:',
      expect.any(Error)
    )
  })

  // The global-capture shortcut broadcasts a bare channel with no payload.
  // Passing an explicit `undefined` would change the send() arity every window
  // sees, so the helper must forward exactly the arguments it was given.
  it('preserves a zero-payload send arity', () => {
    const live = makeLiveWindow()
    windows.push(live.win)

    broadcastToAllWindows('quick-capture:open')

    expect(live.send).toHaveBeenCalledWith('quick-capture:open')
  })
})
