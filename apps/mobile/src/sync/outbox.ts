import {
  PushResponseSchema,
  type PushItem,
  type SyncItemType,
  type SyncOperation,
  type VectorClock
} from '@memry/contracts/sync-api'
import { SyncServerError } from '@memry/sync-client/http-errors'
import { seamJsonRequest, type SeamHttpContext } from '@memry/sync-client/pull'
import {
  encryptCrdtUpdatePacked,
  encryptRecordForPush,
  type SyncPushCryptoProvider
} from '@memry/sync-client/push'
import { increment } from '@memry/sync-client/vector-clock'
import type { VaultDb } from '../db/index'
import { createLogger } from '../lib/logger'
import { applyWriteRejection, getReadOnlyState } from './read-only-mode'

const log = createLogger('Outbox')

/**
 * The mobile write queue (T063).
 *
 * Everything the app writes lands here first and leaves only when the server
 * has accepted it. That ordering is what makes the app offline-first rather
 * than offline-tolerant: an edit made in airplane mode is already durable
 * before any network exists, and a force-quit between enqueue and drain costs
 * nothing.
 *
 * Read-only mode PARKS the queue, never drains it away — a flipped kill switch
 * or a raised version floor must not be able to destroy a user's unsynced work
 * (FR-010). Rows simply wait, and the next drain after the policy clears sends
 * them in order.
 */

export type OutboxOp = 'upsert' | 'delete' | 'crdt-update'

export interface OutboxRow {
  id: number
  itemType: string
  itemId: string
  op: OutboxOp
  payload: Uint8Array | null
  attemptCount: number
  lastError: string | null
}

/** Exponential, capped. Jittered so a fleet of retries does not synchronise. */
export function backoffDelayMs(attemptCount: number): number {
  const base = Math.min(5_000 * 2 ** Math.min(attemptCount, 6), 5 * 60_000)
  return base + Math.floor(Math.random() * Math.min(base, 5_000))
}

const encoder = new TextEncoder()

export class OutboxStore {
  constructor(private readonly db: VaultDb) {}

  /**
   * Queue a record write. The payload is the FULL item JSON — mobile reads the
   * stored payload verbatim, mutates only what changed and writes the whole
   * thing back, so unknown fields a newer desktop wrote survive the round trip
   * untouched (baseline migration's own rule; T065c).
   */
  async enqueueRecord(
    itemType: SyncItemType,
    itemId: string,
    op: Extract<SyncOperation, 'create' | 'update' | 'delete'>,
    payloadJson: string
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO outbox (item_type, item_id, op, payload, enqueued_at) VALUES (?, ?, ?, ?, ?)`,
      [
        `${itemType}:${op}`,
        itemId,
        op === 'delete' ? 'delete' : 'upsert',
        encoder.encode(payloadJson),
        Date.now()
      ]
    )
  }

  /**
   * Queue one Yjs update. Never coalesced at enqueue time: an update that was
   * merged into another one is an update the drain cannot re-send on its own
   * if the merged batch is rejected.
   */
  async enqueueCrdtUpdate(docId: string, update: Uint8Array): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO outbox (item_type, item_id, op, payload, enqueued_at) VALUES (?, ?, ?, ?, ?)`,
      ['note:crdt', docId, 'crdt-update', update, Date.now()]
    )
  }

  async claimBatch(limit: number): Promise<OutboxRow[]> {
    const now = Date.now()
    const rows = await this.db.getAllAsync<{
      id: number
      item_type: string
      item_id: string
      op: OutboxOp
      payload: Uint8Array | null
      attempt_count: number
      last_error: string | null
    }>(
      `SELECT id, item_type, item_id, op, payload, attempt_count, last_error FROM outbox
       WHERE next_attempt_at IS NULL OR next_attempt_at <= ?
       ORDER BY id ASC LIMIT ?`,
      [now, limit]
    )
    return rows.map((r) => ({
      id: r.id,
      itemType: r.item_type,
      itemId: r.item_id,
      op: r.op,
      payload: r.payload ? new Uint8Array(r.payload) : null,
      attemptCount: r.attempt_count,
      lastError: r.last_error
    }))
  }

  async complete(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    // Chunked at 100 to stay inside SQLite's bound-parameter ceiling; the same
    // rule the D1 side already lives under.
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      await this.db.runAsync(
        `DELETE FROM outbox WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      )
    }
  }

  async fail(ids: number[], error: string): Promise<void> {
    for (const id of ids) {
      const row = await this.db.getFirstAsync<{ attempt_count: number }>(
        'SELECT attempt_count FROM outbox WHERE id = ?',
        [id]
      )
      const attempts = (row?.attempt_count ?? 0) + 1
      await this.db.runAsync(
        'UPDATE outbox SET attempt_count = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
        [attempts, error.slice(0, 500), Date.now() + backoffDelayMs(attempts), id]
      )
    }
  }

  async pendingCount(): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')
    return row?.n ?? 0
  }

  /**
   * Drop a note's queued rows. Called when a note is deleted locally: its
   * pending body updates describe a note that no longer exists, and pushing
   * them after the tombstone resurrects content on other devices.
   */
  async dropForItem(itemId: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM outbox WHERE item_id = ? AND op = 'crdt-update'`, [itemId])
  }
}

/**
 * Bump a note payload's vector clock for this device. Desktop keeps the clock
 * inside the payload AND on the push item; both must agree or the receiving
 * side's field merge picks the wrong winner.
 */
export function bumpClock(payload: Record<string, unknown>, deviceId: string): VectorClock {
  const existing = (payload.clock as VectorClock | undefined) ?? {}
  const next = increment(existing, deviceId)
  payload.clock = next
  return next
}

export function logOutboxDepth(depth: number): void {
  if (depth > 0) log.debug('Outbox pending', { depth })
}

// ---------------------------------------------------------------------------
// Drain worker
// ---------------------------------------------------------------------------

/** One drain pass never sends more than this; the server caps a push at 100. */
const RECORD_BATCH_LIMIT = 100
const CLAIM_LIMIT = 200

export interface OutboxDrainDeps {
  store: OutboxStore
  httpCtx: () => SeamHttpContext
  crypto: SyncPushCryptoProvider
  vaultKey: () => Uint8Array | null
  signingSecretKey: () => Uint8Array | null
  deviceId: () => string
  isOnline: () => boolean
}

export interface DrainResult {
  pushed: number
  failed: number
  parked: boolean
  remaining: number
}

export class OutboxDrain {
  private running: Promise<DrainResult> | null = null

  constructor(private readonly deps: OutboxDrainDeps) {}

  /** Coalesces concurrent callers; two overlapping drains would double-send. */
  drain(): Promise<DrainResult> {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<DrainResult> {
    const { store } = this.deps
    const idle = { pushed: 0, failed: 0, parked: false, remaining: 0 }

    if (!this.deps.isOnline()) return { ...idle, remaining: await store.pendingCount() }

    // PARKED, not dropped. The rows stay exactly where they are.
    if (getReadOnlyState().readOnly) {
      const remaining = await store.pendingCount()
      if (remaining > 0) log.info('Outbox parked by read-only mode', { remaining })
      return { ...idle, parked: true, remaining }
    }

    const vaultKey = this.deps.vaultKey()
    const signingSecretKey = this.deps.signingSecretKey()
    if (!vaultKey || !signingSecretKey) {
      // Locked vault: not an error, just nothing we are allowed to encrypt with.
      return { ...idle, remaining: await store.pendingCount() }
    }

    const rows = await store.claimBatch(CLAIM_LIMIT)
    if (rows.length === 0) return idle

    let pushed = 0
    let failed = 0

    // CRDT updates first: a body edit that lands after its own note's delete
    // would be applied to a tombstone.
    const crdtRows = rows.filter((r) => r.op === 'crdt-update')
    const recordRows = rows.filter((r) => r.op !== 'crdt-update')

    const byNote = new Map<string, OutboxRow[]>()
    for (const row of crdtRows) {
      const list = byNote.get(row.itemId) ?? []
      list.push(row)
      byNote.set(row.itemId, list)
    }

    for (const [noteId, noteRows] of byNote) {
      const result = await this.pushCrdt(noteId, noteRows, vaultKey, signingSecretKey)
      pushed += result.pushed
      failed += result.failed
      if (result.stop)
        return { pushed, failed, parked: true, remaining: await store.pendingCount() }
    }

    for (let i = 0; i < recordRows.length; i += RECORD_BATCH_LIMIT) {
      const chunk = recordRows.slice(i, i + RECORD_BATCH_LIMIT)
      const result = await this.pushRecords(chunk, vaultKey, signingSecretKey)
      pushed += result.pushed
      failed += result.failed
      if (result.stop)
        return { pushed, failed, parked: true, remaining: await store.pendingCount() }
    }

    const remaining = await store.pendingCount()
    logOutboxDepth(remaining)
    return { pushed, failed, parked: false, remaining }
  }

  private async pushCrdt(
    noteId: string,
    rows: OutboxRow[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array
  ): Promise<{ pushed: number; failed: number; stop: boolean }> {
    const usable = rows.filter((r) => r.payload !== null)
    if (usable.length === 0) {
      await this.deps.store.complete(rows.map((r) => r.id))
      return { pushed: 0, failed: 0, stop: false }
    }

    try {
      const updates = usable.map((row) =>
        this.deps.crypto.toBase64(
          encryptCrdtUpdatePacked(
            this.deps.crypto,
            row.payload!,
            vaultKey,
            noteId,
            signingSecretKey
          )
        )
      )
      await seamJsonRequest<{ sequences: number[] }>(this.deps.httpCtx(), {
        method: 'POST',
        path: '/sync/crdt/updates',
        body: { noteId, updates }
      })
      await this.deps.store.complete(rows.map((r) => r.id))
      return { pushed: usable.length, failed: 0, stop: false }
    } catch (err) {
      return this.handleFailure(rows, err)
    }
  }

  private async pushRecords(
    rows: OutboxRow[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array
  ): Promise<{ pushed: number; failed: number; stop: boolean }> {
    const items: PushItem[] = []
    const idsById = new Map<string, number[]>()

    for (const row of rows) {
      const [type, operation] = row.itemType.split(':') as [SyncItemType, SyncOperation]
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(new TextDecoder().decode(row.payload ?? new Uint8Array())) as Record<
          string,
          unknown
        >
      } catch {
        // A row we cannot parse can never succeed; retrying it forever would
        // block every later row behind it.
        log.warn('Dropping unparseable outbox row', { id: row.id, itemId: row.itemId })
        await this.deps.store.complete([row.id])
        continue
      }

      const clock = (payload.clock as VectorClock | undefined) ?? {}
      const { pushItem } = await encryptRecordForPush(this.deps.crypto, {
        id: row.itemId,
        type,
        operation,
        content: new TextEncoder().encode(JSON.stringify(payload)),
        vaultKey,
        signingSecretKey,
        signerDeviceId: this.deps.deviceId(),
        clock,
        ...(operation === 'delete' ? { deletedAt: Date.now() } : {})
      })
      items.push(pushItem)
      const list = idsById.get(row.itemId) ?? []
      list.push(row.id)
      idsById.set(row.itemId, list)
    }

    if (items.length === 0) return { pushed: 0, failed: 0, stop: false }

    try {
      const raw = await seamJsonRequest<unknown>(this.deps.httpCtx(), {
        method: 'POST',
        path: '/sync/push',
        body: { items }
      })
      const parsed = PushResponseSchema.safeParse(raw)
      if (!parsed.success) {
        // An unreadable response is not proof of acceptance; retry rather than
        // delete rows the server may never have stored.
        await this.deps.store.fail(
          rows.map((r) => r.id),
          'unparseable push response'
        )
        return { pushed: 0, failed: rows.length, stop: false }
      }

      const acceptedIds: number[] = []
      for (const id of parsed.data.accepted) acceptedIds.push(...(idsById.get(id) ?? []))
      await this.deps.store.complete(acceptedIds)

      const rejectedIds: number[] = []
      for (const rejection of parsed.data.rejected) {
        rejectedIds.push(...(idsById.get(rejection.id) ?? []))
        log.warn('Push item rejected', { itemId: rejection.id, reason: rejection.reason })
      }
      if (rejectedIds.length > 0) await this.deps.store.fail(rejectedIds, 'server rejected item')

      return { pushed: acceptedIds.length, failed: rejectedIds.length, stop: false }
    } catch (err) {
      return this.handleFailure(rows, err)
    }
  }

  /**
   * 403/426 are policy, not failure: they flip the app into read-only, park
   * the queue and stop the pass. Anything else is a transient the backoff owns.
   */
  private async handleFailure(
    rows: OutboxRow[],
    err: unknown
  ): Promise<{ pushed: number; failed: number; stop: boolean }> {
    const message = err instanceof Error ? err.message : String(err)

    if (err instanceof SyncServerError && (err.statusCode === 403 || err.statusCode === 426)) {
      const code =
        err.serverError ??
        (err.statusCode === 426 ? 'CLIENT_UPGRADE_REQUIRED' : 'PLATFORM_WRITES_DISABLED')
      applyWriteRejection(code, extractMinVersion(err))
      // No `fail()`: parked rows must not accumulate backoff for a condition
      // they did not cause, or the first pass after the switch clears sits idle.
      log.warn('Write refused by server policy; outbox parked', { code })
      return { pushed: 0, failed: 0, stop: true }
    }

    await this.deps.store.fail(
      rows.map((r) => r.id),
      message
    )
    log.warn('Outbox push failed; backing off', { rows: rows.length, error: message })
    return { pushed: 0, failed: rows.length, stop: false }
  }
}

function extractMinVersion(err: SyncServerError): string | undefined {
  // The server's error envelope is `{ error: { code, message, minVersion? } }`;
  // the transport flattens the code onto `serverError` and leaves the rest in
  // the message, so this is a best-effort read rather than a parse.
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(err.message)
  return match?.[1]
}
