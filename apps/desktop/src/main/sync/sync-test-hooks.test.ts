import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  engine: null as unknown,
  ws: null as unknown
}))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
vi.mock('./runtime', () => ({
  getSyncEngine: () => runtime.engine,
  getSyncWebSocket: () => runtime.ws
}))

import { syncStateTestHooks } from './sync-test-hooks'

class FakeSocket extends EventEmitter {
  connected = true
  connectionGeneration = 3
  disconnect = vi.fn()
}

function fakeEngine() {
  const state = new Map<string, string>([['syncPaused', 'true']])
  const engine = {
    ctx: { options: { pushBatchSize: 100 } },
    pause: vi.fn(),
    pull: vi.fn(async () => undefined),
    push: vi.fn(async () => {
      pushedWith.push({
        batch: engine.ctx.options.pushBatchSize,
        paused: state.get('syncPaused')
      })
    }),
    getStateValue: (key: string) => state.get(key),
    setStateValue: (key: string, value: string) => void state.set(key, value)
  }
  const pushedWith: Array<{ batch: number; paused: string | undefined }> = []
  return { engine, pushedWith, state }
}

// #2290: the live-lane hooks drive a real engine from Playwright; these pin
// what each one does to the engine and socket it is given.
describe('syncStateTestHooks', () => {
  beforeEach(() => {
    runtime.engine = null
    runtime.ws = null
  })

  it('throws when the sync runtime is not initialized', async () => {
    await expect(syncStateTestHooks.pauseSyncForTests()).rejects.toThrow(/not initialized/)
    await expect(syncStateTestHooks.pushQueuedSyncRowsForTests(1)).rejects.toThrow(
      /not initialized/
    )
    await expect(syncStateTestHooks.startSyncWakeProbeForTests()).rejects.toThrow(/not initialized/)
  })

  it('disconnects the socket and reads sync state through the engine', async () => {
    await expect(syncStateTestHooks.disconnectSyncSocketForTests()).rejects.toThrow(
      /not initialized/
    )
    expect(await syncStateTestHooks.getSyncStateValueForTests('lastCursor')).toBeNull()

    const { engine, state } = fakeEngine()
    const ws = new FakeSocket()
    runtime.engine = engine
    runtime.ws = ws
    state.set('lastCursor', '42')
    await syncStateTestHooks.disconnectSyncSocketForTests()
    expect(ws.disconnect).toHaveBeenCalledOnce()
    expect(await syncStateTestHooks.getSyncStateValueForTests('lastCursor')).toBe('42')
  })

  it('pauses the engine', async () => {
    const { engine } = fakeEngine()
    runtime.engine = engine
    await syncStateTestHooks.pauseSyncForTests()
    expect(engine.pause).toHaveBeenCalledOnce()
  })

  it('pushes at the requested batch size unpaused, then restores both', async () => {
    const { engine, pushedWith, state } = fakeEngine()
    runtime.engine = engine
    await syncStateTestHooks.pushQueuedSyncRowsForTests(1)
    expect(pushedWith).toEqual([{ batch: 1, paused: 'false' }])
    expect(engine.ctx.options.pushBatchSize).toBe(100)
    expect(state.get('syncPaused')).toBe('true')
  })

  it('counts changes_available wakes and engine pulls, and resets on restart', async () => {
    const { engine } = fakeEngine()
    const ws = new FakeSocket()
    runtime.engine = engine
    runtime.ws = ws

    await syncStateTestHooks.startSyncWakeProbeForTests()
    ws.emit('message', { kind: 'changes_available', cursor: 5 })
    ws.emit('message', { kind: 'crdt_updated', noteId: 'n1' })
    await engine.pull()
    expect(await syncStateTestHooks.getSyncWakeProbeForTests()).toEqual({ wakes: 1, pulls: 1 })

    await syncStateTestHooks.startSyncWakeProbeForTests()
    expect(await syncStateTestHooks.getSyncWakeProbeForTests()).toEqual({ wakes: 0, pulls: 0 })
    ws.emit('message', { kind: 'changes_available' })
    expect(await syncStateTestHooks.getSyncWakeProbeForTests()).toEqual({ wakes: 1, pulls: 0 })
  })

  it('reports the socket state with the refusals it saw', async () => {
    const { engine } = fakeEngine()
    const ws = new FakeSocket()
    runtime.engine = engine
    runtime.ws = ws

    await syncStateTestHooks.startSyncWakeProbeForTests()
    ws.emit('error', new Error('boom'))
    ws.emit('version_rejected', 'HTTP 426')

    const state = await syncStateTestHooks.getSyncSocketStateForTests()
    expect(state).toMatchObject({
      connected: true,
      connectionGeneration: 3,
      internals: { appVersion: '9.9.9' }
    })
    expect(state.errors.slice(-2)).toEqual(['boom', 'version_rejected: HTTP 426'])
  })

  it('reports a missing socket as disconnected', async () => {
    expect(await syncStateTestHooks.getSyncSocketStateForTests()).toMatchObject({
      connected: false,
      connectionGeneration: 0,
      internals: { hasSocket: false }
    })
  })
})
