import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_EVENTS } from '@memry/contracts/ipc-sync'

const electronMock = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

vi.mock('electron', () => electronMock)

import { onCrdtStateChanged } from './sync-ops'

type StateChangedPayload = { noteId: string; update: Uint8Array; origin: string }

/**
 * Stand-in for the main process broadcasting on the shared CRDT channel: pushes
 * a payload through whatever handler the preload registry attached to
 * `ipcRenderer`, exactly as Electron would.
 */
function broadcast(payload: StateChangedPayload): void {
  const attached = electronMock.ipcRenderer.on.mock.calls.filter(
    ([channel]) => channel === SYNC_EVENTS.STATE_CHANGED
  )
  const removed = electronMock.ipcRenderer.removeListener.mock.calls.filter(
    ([channel]) => channel === SYNC_EVENTS.STATE_CHANGED
  )
  const live = attached
    .map(([, handler]) => handler as (event: unknown, data: unknown) => void)
    .filter((handler) => !removed.some(([, removedHandler]) => removedHandler === handler))

  for (const handler of live) handler({}, payload)
}

function liveListenerCount(): number {
  const attached = electronMock.ipcRenderer.on.mock.calls.filter(
    ([channel]) => channel === SYNC_EVENTS.STATE_CHANGED
  )
  const removed = electronMock.ipcRenderer.removeListener.mock.calls.filter(
    ([channel]) => channel === SYNC_EVENTS.STATE_CHANGED
  )
  return attached.length - removed.length
}

function update(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('onCrdtStateChanged note routing', () => {
  it('delivers a note update only to that note’s subscriber', () => {
    // #given — two open notes, each with its own subscriber
    const noteA = vi.fn()
    const noteB = vi.fn()
    const offA = onCrdtStateChanged('note-a', noteA)
    const offB = onCrdtStateChanged('note-b', noteB)

    // #when — the main process broadcasts an update for note A
    broadcast({ noteId: 'note-a', update: update('a'), origin: 'local' })

    // #then — note B's provider is never woken, and never sees A's bytes
    expect(noteA).toHaveBeenCalledTimes(1)
    expect(noteA).toHaveBeenCalledWith({
      noteId: 'note-a',
      update: update('a'),
      origin: 'local'
    })
    expect(noteB).not.toHaveBeenCalled()

    offA()
    offB()
  })

  it('keeps every subscriber of the same note (registry is not last-writer-wins)', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = onCrdtStateChanged('note-a', first)
    const offSecond = onCrdtStateChanged('note-a', second)

    broadcast({ noteId: 'note-a', update: update('a'), origin: 'network' })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    offFirst()
    offSecond()
  })

  it('drops updates for notes nobody subscribed to without throwing', () => {
    const noteA = vi.fn()
    const off = onCrdtStateChanged('note-a', noteA)

    expect(() =>
      broadcast({ noteId: 'note-unknown', update: update('x'), origin: 'local' })
    ).not.toThrow()
    expect(noteA).not.toHaveBeenCalled()

    off()
  })

  it('isolates a throwing subscriber from the others on the same note', () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber exploded')
    })
    const healthy = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offBoom = onCrdtStateChanged('note-a', boom)
    const offHealthy = onCrdtStateChanged('note-a', healthy)

    broadcast({ noteId: 'note-a', update: update('a'), origin: 'local' })

    expect(boom).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()

    offBoom()
    offHealthy()
  })

  it('tolerates a subscriber that unsubscribes itself mid-dispatch', () => {
    const other = vi.fn()
    let offSelf = (): void => {}
    const selfClosing = vi.fn(() => offSelf())
    offSelf = onCrdtStateChanged('note-a', selfClosing)
    const offOther = onCrdtStateChanged('note-a', other)

    expect(() =>
      broadcast({ noteId: 'note-a', update: update('a'), origin: 'local' })
    ).not.toThrow()
    expect(other).toHaveBeenCalledTimes(1)

    offOther()
  })
})

describe('onCrdtStateChanged listener lifetime', () => {
  it('attaches the channel listener synchronously so no broadcast is missed', () => {
    // #given/#when — the very first broadcast lands the instant we subscribe
    const noteA = vi.fn()
    const off = onCrdtStateChanged('note-a', noteA)

    // #then — the ipcRenderer listener already exists, so nothing is lost in the
    // gap between opening a note and its provider being wired.
    expect(liveListenerCount()).toBe(1)
    broadcast({ noteId: 'note-a', update: update('a'), origin: 'local' })
    expect(noteA).toHaveBeenCalledTimes(1)

    off()
  })

  it('shares one ipcRenderer listener across many open notes', () => {
    const unsubscribes = Array.from({ length: 25 }, (_, index) =>
      onCrdtStateChanged(`note-${index}`, vi.fn())
    )

    expect(liveListenerCount()).toBe(1)

    for (const off of unsubscribes) off()
    expect(liveListenerCount()).toBe(0)
  })

  it('keeps the channel listener while any other note is still subscribed', () => {
    const noteB = vi.fn()
    const offA = onCrdtStateChanged('note-a', vi.fn())
    const offB = onCrdtStateChanged('note-b', noteB)

    offA()

    expect(liveListenerCount()).toBe(1)
    broadcast({ noteId: 'note-b', update: update('b'), origin: 'local' })
    expect(noteB).toHaveBeenCalledTimes(1)

    offB()
    expect(liveListenerCount()).toBe(0)
  })

  it('stays bounded across many open/close cycles', () => {
    // #given/#when — 200 open→close cycles, the shape of a user tabbing around
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const off = onCrdtStateChanged(`note-${cycle}`, vi.fn())
      expect(liveListenerCount()).toBe(1)
      off()
    }

    // #then — nothing accumulates: no leaked ipcRenderer listener, and the
    // closed notes leave no per-note bucket behind (a leak would keep the
    // channel listener attached).
    expect(liveListenerCount()).toBe(0)
  })

  it('is idempotent on repeated unsubscribe and does not detach a live listener', () => {
    const noteB = vi.fn()
    const offA = onCrdtStateChanged('note-a', vi.fn())
    offA()
    expect(liveListenerCount()).toBe(0)

    const offB = onCrdtStateChanged('note-b', noteB)
    offA()

    expect(liveListenerCount()).toBe(1)
    broadcast({ noteId: 'note-b', update: update('b'), origin: 'local' })
    expect(noteB).toHaveBeenCalledTimes(1)

    offB()
  })

  it('re-arms cleanly after a full teardown (vault switch)', () => {
    // #given — a vault's notes are open
    const beforeSwitch = vi.fn()
    const offBefore = onCrdtStateChanged('note-a', beforeSwitch)

    // #when — the vault switch tears every provider down, then the new vault's
    // notes subscribe
    offBefore()
    expect(liveListenerCount()).toBe(0)

    const afterSwitch = vi.fn()
    const offAfter = onCrdtStateChanged('note-a', afterSwitch)

    // #then — exactly one listener again, delivering to the new subscriber only
    expect(liveListenerCount()).toBe(1)
    broadcast({ noteId: 'note-a', update: update('a'), origin: 'local' })
    expect(afterSwitch).toHaveBeenCalledTimes(1)
    expect(beforeSwitch).not.toHaveBeenCalled()

    offAfter()
  })
})
