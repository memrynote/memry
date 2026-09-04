import {
  buildClientHeaderValue,
  CrdtBodyPuller,
  RecordPullEngine,
  seamJsonRequest,
  type PullRunResult,
  type SeamHttpContext
} from '@memry/sync-client/pull'
import { DeviceKeysResponseSchema } from '@memry/contracts/sync-api'
import type { SyncHttpClient } from '@memry/sync-client/adapters'
import { createMobileHttpClient } from '../adapters/http-client'
import { bodyPullTargets } from './body-pull-targets'
import { mobileAppVersion } from '../adapters/runtime'
import { openVaultDb } from '../db/index'
import { openDocIdsFor } from '../editor/session'
import { MobilePullStore } from '../db/pull-store'
import { fromBase64 } from '../crypto/libsodium'
import { recordSyncOutcome } from './sync-state'
import { createLogger } from '../lib/logger'
import { getVaultKey } from '../lib/secure-store'
import { loadSession, refreshSession } from './auth-client'
import { createMobileCryptoProvider } from './crypto-provider'
import { materializeNoteBody } from './note-materializer'
import { applyClientPolicy } from './read-only-mode'
import { syncBaseUrl } from './server-config'

const log = createLogger('MobileSyncEngine')

/**
 * T045: the `@memry/sync-client` pull pipeline wired to the mobile adapters.
 * One engine per vault; `sync()` is the incremental pass (record feed → CRDT
 * bodies → preview materialization → status/kill-switch poll).
 *
 * The `x-memry-client: ios/<semver>+<build>` header (T046) rides on every
 * request via the engine's clientHeaderValue.
 */
export class MobileSyncEngine {
  private online = true
  private syncing: Promise<SyncSummary> | null = null
  private vaultKeyCache: Uint8Array | null = null
  private accessToken = ''
  private readonly http: SyncHttpClient
  private readonly crypto = createMobileCryptoProvider()
  private readonly clientHeaderValue = buildClientHeaderValue('ios', mobileAppVersion())
  private deviceKeys = new Map<string, Uint8Array | null>()
  private deviceKeysFetched = false
  private listeners = new Set<(summary: SyncSummary) => void>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly vaultId: string) {
    this.http = createMobileHttpClient(syncBaseUrl())
    // NetInfo emits the CURRENT state immediately on subscribe; syncing on
    // that first emission raced the windowed first sync (two transactions on
    // one SQLite connection, and a shared record cursor — the 83-items-stuck
    // wedge). Only genuine offline→online transitions trigger a pass.
    let initialEmission = true
    this.http.onOnlineChanged((online) => {
      this.online = online
      if (initialEmission) {
        initialEmission = false
        return
      }
      if (online) {
        void this.sync().catch(() => {})
      }
    })
  }

  /**
   * Every pipeline that touches the vault DB or the record cursor runs
   * through this queue. sync(), the first-sync phases and on-demand fetches
   * used to interleave — expo-sqlite shares one connection per DB, so two
   * concurrent withTransactionAsync calls throw, and two concurrent pulls
   * race the cursor.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  onSynced(listener: (summary: SyncSummary) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async prepare(): Promise<{ store: MobilePullStore } | null> {
    const session = await loadSession()
    if (!session) return null
    this.accessToken = session.accessToken
    this.vaultKeyCache = await getVaultKey(this.vaultId)
    if (!this.vaultKeyCache) return null
    const db = await openVaultDb(this.vaultId)
    return { store: new MobilePullStore(db, this.vaultId) }
  }

  private makeEngine(store: MobilePullStore): RecordPullEngine {
    return new RecordPullEngine({
      http: this.http,
      crypto: this.crypto,
      store,
      vaultId: this.vaultId,
      clientHeaderValue: this.clientHeaderValue,
      getAccessToken: () => this.accessToken,
      refreshAccessToken: () => this.refreshAndCacheToken(),
      getVaultKey: () => this.vaultKeyCache,
      log,
      isOnline: () => this.online
    })
  }

  private async refreshAndCacheToken(): Promise<string | null> {
    const fresh = await refreshSession()
    if (fresh) this.accessToken = fresh
    return fresh
  }

  private httpCtx(): SeamHttpContext {
    return {
      http: this.http,
      accessToken: () => this.accessToken,
      vaultId: this.vaultId,
      clientHeaderValue: this.clientHeaderValue
    }
  }

  private async resolveDeviceKey(deviceId: string): Promise<Uint8Array | null> {
    if (!this.deviceKeysFetched) {
      try {
        const raw = await seamJsonRequest<unknown>(this.httpCtx(), {
          method: 'GET',
          path: '/auth/devices'
        })
        const parsed = DeviceKeysResponseSchema.safeParse(raw)
        if (parsed.success) {
          for (const device of parsed.data.devices) {
            this.deviceKeys.set(device.id, fromBase64(device.signingPublicKey))
          }
        }
        this.deviceKeysFetched = true
      } catch (err) {
        log.warn('Device key fetch failed', {
          error: err instanceof Error ? err.message : String(err)
        })
        return null
      }
    }
    return this.deviceKeys.get(deviceId) ?? null
  }

  /** Incremental sync pass. Coalesces concurrent callers into one run. */
  sync(): Promise<SyncSummary> {
    if (this.syncing) return this.syncing
    this.syncing = this.exclusive(() => this.runSync()).finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async runSync(): Promise<SyncSummary> {
    const prepared = await this.prepare()
    if (!prepared) {
      // Not recorded: a locked vault is the app waiting on the user, not a
      // sync failure, and counting it would inflate the retry backoff.
      return { ok: false, reason: 'locked', itemsApplied: 0, bodiesUpdated: 0, changedNoteIds: [] }
    }
    const { store } = prepared

    const engine = this.makeEngine(store)
    let record: PullRunResult
    try {
      record = await engine.pullIncremental()
    } catch (err) {
      log.warn('Record pull failed', { error: err instanceof Error ? err.message : String(err) })
      await recordSyncOutcome(this.vaultId, { ok: false, reason: 'error' })
      return { ok: false, reason: 'error', itemsApplied: 0, bodiesUpdated: 0, changedNoteIds: [] }
    }

    const targets = bodyPullTargets(record.changedNoteIds, await openDocIdsFor(this.vaultId))
    const bodies = await this.pullBodiesForUnlocked(store, targets)
    await this.pollStatus(engine)

    const summary: SyncSummary = {
      ok: record.ok,
      reason: record.ok ? null : 'refused',
      itemsApplied: record.itemsApplied,
      bodiesUpdated: bodies,
      changedNoteIds: targets
    }
    await recordSyncOutcome(this.vaultId, { ok: summary.ok, reason: summary.reason })
    for (const listener of this.listeners) listener(summary)
    return summary
  }

  pullBodiesFor(store: MobilePullStore, noteIds: string[]): Promise<number> {
    return this.exclusive(() => this.pullBodiesForUnlocked(store, noteIds))
  }

  private async pullBodiesForUnlocked(store: MobilePullStore, noteIds: string[]): Promise<number> {
    if (noteIds.length === 0 || !this.vaultKeyCache) return 0
    const db = await openVaultDb(this.vaultId)
    const puller = new CrdtBodyPuller({
      httpCtx: () => this.httpCtx(),
      crypto: this.crypto,
      store,
      resolveDeviceKey: (id) => this.resolveDeviceKey(id),
      getVaultKey: () => this.vaultKeyCache,
      log,
      isOnline: () => this.online,
      onNoteBodyChanged: async (noteId) => {
        await materializeNoteBody(db, store, noteId)
      }
    })
    const result = await puller.pullBodies(noteIds)
    return result.notesUpdated
  }

  /** Pull specific record blobs (windowed first sync / on-demand). */
  pullBlobs(itemIds: string[]): Promise<{ applied: number; changedNoteIds: string[] }> {
    return this.exclusive(async () => {
      const prepared = await this.prepare()
      if (!prepared) return { applied: 0, changedNoteIds: [] }
      const engine = this.makeEngine(prepared.store)
      const result = await engine.pullBlobsByIds(itemIds)
      return { applied: result.applied, changedNoteIds: result.changedNoteIds }
    })
  }

  pullRefsToEnd(): Promise<number> {
    return this.exclusive(async () => {
      const prepared = await this.prepare()
      if (!prepared) return 0
      const engine = this.makeEngine(prepared.store)
      const { refs } = await engine.pullRefsToEnd()
      return refs
    })
  }

  async getStore(): Promise<MobilePullStore | null> {
    const prepared = await this.prepare()
    return prepared?.store ?? null
  }

  /** Status poll — how the kill switch / version gate is learned (T051). */
  private async pollStatus(engine: RecordPullEngine): Promise<void> {
    try {
      const status = await engine.fetchStatus()
      if (status) applyClientPolicy(status.clientPolicy, mobileAppVersion().split('+')[0])
    } catch (err) {
      log.debug('Status poll failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

export interface SyncSummary {
  ok: boolean
  reason: 'locked' | 'error' | 'refused' | null
  itemsApplied: number
  bodiesUpdated: number
  /**
   * Notes whose CRDT state this pass asked the server about.
   *
   * Carried out of the engine so an OPEN editor can be fed the new rows; the
   * doc manager caches docs for the process lifetime, so a pull that lands
   * server updates is otherwise invisible until the app restarts.
   *
   * This is the same union the pass pulled bodies for, not just the notes the
   * record feed named. Halving it was the on-screen half of the body-only bug:
   * the heal path would fetch a peer's edit into SQLite and the editor showing
   * that very note would keep painting the old text until it was reopened.
   * Refreshing a doc with no new server rows is a no-op, so the wider set costs
   * nothing.
   */
  changedNoteIds: string[]
}

const engines = new Map<string, MobileSyncEngine>()

export function getSyncEngine(vaultId: string): MobileSyncEngine {
  let engine = engines.get(vaultId)
  if (!engine) {
    engine = new MobileSyncEngine(vaultId)
    engines.set(vaultId, engine)
  }
  return engine
}
