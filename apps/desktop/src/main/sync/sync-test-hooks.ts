import { app } from 'electron'
import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { sql } from 'drizzle-orm'
import { RateLimitError } from '@memry/sync-client/http-errors'
import { getSyncEngine, getSyncWebSocket, startSyncRuntime, stopSyncRuntime } from './runtime'
import type { SyncEngine } from './engine'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { resolveVaultCrdtStore } from './crdt-store-path'
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

/** One `crdt_body_debts` row, as the debt-restart lane reads it (#2297). */
export interface CrdtBodyDebtForTests {
  noteId: string
  reason: string
  generation: number
  failures: number
  lastFailedAt: number | null
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

  /**
   * Stop every CRDT body pull that is not the change feed on this device: the
   * `crdt_updated` pull, the pull after a record page, the reconnect pulls and
   * the vault sweeps, until the runtime restarts (#2297 live lane). Patched on
   * the coordinator instance, so it works against any engine build.
   */
  async disableCrdtBodyPullsForTests(): Promise<void> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    const crdtSync = engine['crdtSync']
    crdtSync.pullCrdtForNote = async () => true
    crdtSync.pullCrdtForNotes = async () => ({ snapshotGets: 0, batchPosts: 0 })
    crdtSync.applyCrdtBatch = async () => ({ snapshotGets: 0, batchPosts: 0 })
    crdtSync.applyCrdtIncrementals = async () => false
  },

  /**
   * Answer every CRDT body pull that is not the change feed with a rate limit,
   * through the coordinator's real failure path, so the notes it would pull
   * stay owed (#2297 live lane). Until the runtime restarts.
   */
  async rateLimitCrdtBodyPullsForTests(): Promise<void> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    const crdtSync = engine['crdtSync'] as unknown as Record<string, unknown>
    const rateLimited = async (): Promise<never> => {
      throw new RateLimitError()
    }
    crdtSync.probeBatchChunk = rateLimited
    crdtSync.applySnapshotBaseline = rateLimited
  },

  /**
   * This device's durable CRDT body debts (#2297), or null on a build without
   * the `crdt_body_debts` table, so a spec runs against either build.
   */
  async getCrdtBodyDebtsForTests(): Promise<CrdtBodyDebtForTests[] | null> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    try {
      return engine['ctx'].deps.db.all<CrdtBodyDebtForTests>(
        sql`SELECT note_id AS noteId, reason, generation, failures, last_failed_at AS lastFailedAt
          FROM crdt_body_debts ORDER BY note_id`
      )
    } catch {
      return null
    }
  },

  /** One record pull, the path a `changes_available` wake takes, never a full sync. */
  async pullSyncForTests(): Promise<boolean> {
    const engine = getSyncEngine()
    if (!engine) {
      throw new Error('Sync runtime is not initialized')
    }
    return engine.pull()
  },

  async getSyncWakeProbeForTests(): Promise<SyncWakeProbeCounts> {
    return { wakes: wakeProbe.wakes, pulls: wakeProbe.pulls }
  },

  /** Every per-vault CRDT store directory on disk (#2424: an adopted vault keeps one). */
  async listCrdtStoreDirsForTests(): Promise<string[]> {
    const store = resolveVaultCrdtStore()
    if (!store) return []
    const root = path.dirname(store.storagePath)
    return existsSync(root) ? readdirSync(root).sort() : []
  },

  /**
   * Stop and start this device's sync runtime without the shutdown snapshot
   * push, so queued CRDT body rows are the only carrier of edits that had not
   * flushed (#2298).
   */
  async restartSyncRuntimeForTests(): Promise<void> {
    await stopSyncRuntime({ skipFinalSync: true })
    await startSyncRuntime()
  }
}

export type SyncStateTestHooks = typeof syncStateTestHooks
