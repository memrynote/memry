import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sendSync: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  logError: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: mocks.invoke,
    sendSync: mocks.sendSync,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener
  }
}))

import { invoke, invokeSync, send, subscribe } from './ipc'

// electron-log's own preload script puts this on the preload world's global;
// `subscribe` writes listener failures there rather than importing
// electron-log (which would hang the preload suite at collection time).
const globalWithLog = globalThis as typeof globalThis & {
  __electronLog?: { error: (...data: unknown[]) => void }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalWithLog.__electronLog = { error: mocks.logError }
})

afterEach(() => {
  delete globalWithLog.__electronLog
})

describe('preload ipc primitives', () => {
  it('invoke forwards channel + args and returns the underlying promise', async () => {
    mocks.invoke.mockResolvedValue('ok')
    const result = await invoke('some:channel' as never, { a: 1 } as never)
    expect(mocks.invoke).toHaveBeenCalledWith('some:channel', { a: 1 })
    expect(result).toBe('ok')
  })

  it('invokeSync uses sendSync', () => {
    mocks.sendSync.mockReturnValue(7)
    expect(invokeSync('sync:channel')).toBe(7)
    expect(mocks.sendSync).toHaveBeenCalledWith('sync:channel')
  })

  it('send forwards channel + args', () => {
    send('evt:channel', 'x', 'y')
    expect(mocks.send).toHaveBeenCalledWith('evt:channel', 'x', 'y')
  })
})

describe('subscribe reference counting', () => {
  // channelSubscriptions is module-level state, so give each test a fresh channel name.
  it('registers a single ipcRenderer listener per channel and fans out to all callbacks', () => {
    // #given two subscribers on the same channel
    const a = vi.fn()
    const b = vi.fn()
    subscribe('chan-fanout', a)
    subscribe('chan-fanout', b)

    // #then only one underlying listener is attached
    expect(mocks.on).toHaveBeenCalledTimes(1)
    expect(mocks.on).toHaveBeenCalledWith('chan-fanout', expect.any(Function))

    // #when the shared handler receives a payload
    const handler = mocks.on.mock.calls[0][1] as (e: unknown, p: unknown) => void
    handler({}, { hello: 'world' })

    // #then both callbacks fire with the payload (not the event)
    expect(a).toHaveBeenCalledWith({ hello: 'world' })
    expect(b).toHaveBeenCalledWith({ hello: 'world' })
  })

  it('unsubscribing one callback keeps the listener alive for the rest', () => {
    // #given
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribe('chan-partial', a)
    subscribe('chan-partial', b)
    const handler = mocks.on.mock.calls[0][1] as (e: unknown, p: unknown) => void

    // #when a unsubscribes
    offA()
    handler({}, 'ping')

    // #then only b receives, listener not removed
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith('ping')
    expect(mocks.removeListener).not.toHaveBeenCalled()
  })

  it('removes the underlying listener when the last callback unsubscribes', () => {
    // #given
    const off = subscribe('chan-last', vi.fn())
    const handler = mocks.on.mock.calls[0][1]

    // #when
    off()

    // #then
    expect(mocks.removeListener).toHaveBeenCalledWith('chan-last', handler)

    // and a fresh subscribe re-attaches (map entry was cleaned up)
    subscribe('chan-last', vi.fn())
    expect(mocks.on).toHaveBeenCalledTimes(2)
  })

  it('is idempotent — calling the unsubscribe twice is a no-op', () => {
    const off = subscribe('chan-idem', vi.fn())
    off()
    off()
    expect(mocks.removeListener).toHaveBeenCalledTimes(1)
  })

  it('a throwing callback does not abort the rest of the fan-out', () => {
    // #given a listener that throws on an unexpected payload shape, registered
    // before two healthy ones (this is what a sync-emitted `{ id }` event did)
    const boom = vi.fn(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'targetType')")
    })
    const second = vi.fn()
    const third = vi.fn()
    subscribe('chan-throw', boom)
    subscribe('chan-throw', second)
    subscribe('chan-throw', third)
    const handler = mocks.on.mock.calls[0][1] as (e: unknown, p: unknown) => void

    // #when the shared handler dispatches
    expect(() => handler({}, { id: 'rem-1' })).not.toThrow()

    // #then every later listener still ran, and the failure was logged
    expect(boom).toHaveBeenCalledWith({ id: 'rem-1' })
    expect(second).toHaveBeenCalledWith({ id: 'rem-1' })
    expect(third).toHaveBeenCalledWith({ id: 'rem-1' })
    expect(mocks.logError).toHaveBeenCalledWith(
      '[PreloadIpc] Listener for "chan-throw" threw',
      expect.any(TypeError)
    )
  })

  it('a throwing callback does not poison later events on the channel', () => {
    const boom = vi.fn(() => {
      throw new Error('bad payload')
    })
    const healthy = vi.fn()
    subscribe('chan-throw-repeat', boom)
    subscribe('chan-throw-repeat', healthy)
    const handler = mocks.on.mock.calls[0][1] as (e: unknown, p: unknown) => void

    handler({}, 'first')
    handler({}, 'second')

    expect(healthy).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenLastCalledWith('second')
  })
})
