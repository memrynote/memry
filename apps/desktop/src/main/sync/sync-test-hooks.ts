import { app } from 'electron'
import { getSyncEngine, getSyncWebSocket } from './runtime'
import type { SyncEngine } from './engine'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'

export interface SyncWakeProbeCounts {
  wakes: number
  pulls: number
}

// Counts `changes_available` frames and engine pulls from the outside, so the
// E2E reads the same numbers whatever engine.ts build it runs against.
const wakeProbe: SyncWakeProbeCounts & { engine: SyncEngine | null; socketErrors: string[] } = {
  wakes: 0,
  pulls: 0,
  engine: null,
  socketErrors: []
}

export interface SyncSocketStateForTests {
  connected: boolean
  connectionGeneration: number
  errors: string[]
  internals: Record<string, unknown>
}

export const syncStateTestHooks = {
  async disconnectSyncSocketForTests(): Promise<void> {
    const ws = getSyncWebSocket()
    if (!ws) {
      throw new Error('Sync runtime is not initialized')
    }
    ws.disconnect()
  },

  async getSyncStateValueForTests(key: string): Promise<string | null> {
    return getSyncEngine()?.getStateValue(key) ?? null
  },

  async pauseSyncForTests(): Promise<void> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    engine.pause()
  },

  /**
   * Push every queued row now, `rowsPerRequest` rows per request, even while
   * sync is paused, then restore the pause. A paused engine arms no push
   * debounce, so the test alone decides how rows split into requests (one
   * peer wake each).
   */
  async pushQueuedSyncRowsForTests(rowsPerRequest: number): Promise<void> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    const options = engine['ctx'].options
    const pushBatchSize = options.pushBatchSize
    const paused = engine.getStateValue(SYNC_STATE_KEYS.SYNC_PAUSED) ?? 'false'
    options.pushBatchSize = rowsPerRequest
    engine.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, 'false')
    try {
      await engine.push()
    } finally {
      options.pushBatchSize = pushBatchSize
      engine.setStateValue(SYNC_STATE_KEYS.SYNC_PAUSED, paused)
    }
  },

  async startSyncWakeProbeForTests(): Promise<void> {
    const engine = getSyncEngine()
    const ws = getSyncWebSocket()
    if (!engine || !ws) {
      throw new Error('Sync runtime is not initialized')
    }
    wakeProbe.wakes = 0
    wakeProbe.pulls = 0
    if (wakeProbe.engine === engine) return
    wakeProbe.engine = engine

    const pull = engine.pull.bind(engine)
    engine.pull = () => {
      wakeProbe.pulls++
      return pull()
    }
    ws.on('message', (message: SyncSocketEvent) => {
      if (message.kind === 'changes_available') wakeProbe.wakes++
    })
    ws.on('error', (error: Error) => {
      wakeProbe.socketErrors = [...wakeProbe.socketErrors, error.message].slice(-5)
    })
    ws.on('version_rejected', (reason: string) => {
      wakeProbe.socketErrors = [...wakeProbe.socketErrors, `version_rejected: ${reason}`].slice(-5)
    })
  },

  async getSyncSocketStateForTests(): Promise<SyncSocketStateForTests> {
    const ws = getSyncWebSocket()
    const fields = (ws ?? {}) as unknown as Record<string, unknown>
    return {
      connected: ws?.connected ?? false,
      connectionGeneration: ws?.connectionGeneration ?? 0,
      errors: wakeProbe.socketErrors,
      internals: {
        hasSocket: fields.ws != null,
        shouldBeConnected: fields.shouldBeConnected,
        reconnectAttempt: fields.reconnectAttempt,
        reconnectArmed: fields.reconnectTimer != null,
        authFailed: fields.authFailed,
        versionRejected: fields.versionRejected,
        certPinFailed: fields.certPinFailed,
        appVersion: app.getVersion()
      }
    }
  },

  async getSyncWakeProbeForTests(): Promise<SyncWakeProbeCounts> {
    return { wakes: wakeProbe.wakes, pulls: wakeProbe.pulls }
  }
}

export type SyncStateTestHooks = typeof syncStateTestHooks
