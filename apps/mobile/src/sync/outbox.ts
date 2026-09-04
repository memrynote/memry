import {
  PushResponseSchema,
  type PushItem,
  type SyncItemType,
  type SyncOperation,
  type VectorClock
} from '@memry/contracts/sync-api'
import { SyncServerError } from '@memry/sync-client/http-errors'
import { seamJsonRequest, type SeamHttpContext } from '@memry/sync-client/pull'
import { ItemTooLargeError } from '@memry/sync-client/note-size'
import { planCrdtUpdatePush } from '@memry/sync-client/crdt-payload'
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
    // Supersede this device's earlier pending rows for the same item. The
    // payload is the WHOLE object as it stands now, so an older row says
    // nothing this one does not — and leaving it queued is a real hazard: a
    // row still serving a backoff is invisible to the batch that collapses
    // per item id, and would later re-push a stale full payload over the
    // newer one that already landed.
    await this.db.runAsync(`DELETE FROM outbox WHERE item_id = ? AND op != 'crdt-update'`, [itemId])
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
    if (ids.length === 0) return
    const now = Date.now()
    const message = error.slice(0, 500)
    // One statement per row, not a read plus a write: the attempt count is
    // incremented in SQL, and the delay is computed from the row's own count
    // rather than from one this code had to fetch first.
    for (const id of ids) {
      const row = await this.db.getFirstAsync<{ attempt_count: number }>(
        'SELECT attempt_count FROM outbox WHERE id = ?',
        [id]
      )
      const attempts = (row?.attempt_count ?? 0) + 1
      await this.db.runAsync(
        'UPDATE outbox SET attempt_count = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
        [attempts, message, now + backoffDelayMs(attempts), id]
      )
    }
  }

  /**
   * Clear the backoff on the rows that just failed.
   *
   * Used after a token refresh: those rows are sitting on a ≥10 s
   * `next_attempt_at`, so an immediate retry drain would claim nothing and the
   * refresh would be a no-op the user experiences as lost work.
   *
   * Scoped, not global. Clearing the whole table would reset the backoff of
   * every unrelated row — one failed flush plus one successful refresh would
   * disable exponential backoff outright, which is how a transient server
   * problem turns into a request storm.
   */
  async clearBackoff(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      await this.db.runAsync(
        `UPDATE outbox SET next_attempt_at = NULL WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
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

/**
 * The server's cap on `updates` in one `POST /sync/crdt/updates`.
 *
 * Exceeding it is a 400 that repeats on every drain, so a note edited heavily
 * offline would never sync its body again. The COUNT is only half of it — the
 * request also has to fit the byte budgets `planCrdtUpdatePush` enforces (a D1
 * row cap per update, an 8 MiB body cap per request), and a 250-update chunk
 * of large pastes clears the count and still 413s.
 */
const CRDT_UPDATES_PER_REQUEST = 100

/** Server codes that mean "policy", not "failure" — see `handleFailure`. */
const POLICY_REJECTION_CODES = new Set(['PLATFORM_WRITES_DISABLED', 'CLIENT_UPGRADE_REQUIRED'])
const CLAIM_LIMIT = 200

/**
 * The queue operations the drain uses.
 *
 * Named separately from `OutboxStore` so the drain's failure handling can be
 * tested without expo-sqlite — the paths that matter here are the ones where a
 * row ends up neither completed nor failed, which is invisible in a DB and
 * obvious in a call log.
 */
export interface OutboxQueue {
  claimBatch(limit: number): Promise<OutboxRow[]>
  complete(ids: number[]): Promise<void>
  fail(ids: number[], error: string): Promise<void>
  pendingCount(): Promise<number>
}

export interface OutboxDrainDeps {
  store: OutboxQueue
  /**
   * Full Y.Doc state for a note, used when a single update is too large to
   * send incrementally.
   *
   * Without it such an update has nowhere to go: it cannot be split, and
   * dropping it would lose the edit. A snapshot supersedes it and every update
   * queued behind it, which is exactly what the desktop path does.
   */
  encodeDocSnapshot?: (docId: string) => Promise<Uint8Array | null>
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
  /**
   * Rows this pass put on a backoff.
   *
   * Named rather than counted so a caller that fixes the CAUSE — a token
   * refresh, typically — can clear the backoff on exactly those rows instead
   * of the whole table.
   */
  failedIds: number[]
  parked: boolean
  remaining: number
}

export class OutboxDrain {
  private running: Promise<DrainResult> | null = null
  private trailing: Promise<DrainResult> | null = null

  constructor(private readonly deps: OutboxDrainDeps) {}

  /**
   * Drain the queue. Never two passes at once — that would double-send — and
   * at most one pass waiting behind the running one.
   *
   * A caller that arrives mid-pass gets that TRAILING pass rather than the
   * in-flight one, which is the whole point on a background transition: the
   * app-wide handler starts a drain, the editor then flushes its last
   * keystrokes into the queue, and joining the earlier pass would report
   * "done" for work enqueued after it read the queue. Those keystrokes would
   * sit until the next foreground edge. Several mid-pass callers share the one
   * trailing pass, so a burst does not become a burst of passes.
   */
  drain(): Promise<DrainResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null
      })
      return this.running
    }
    if (!this.trailing) {
      this.trailing = this.running
        .catch(() => undefined)
        .then(() => this.drain())
        .finally(() => {
          this.trailing = null
        })
    }
    return this.trailing
  }

  private async run(): Promise<DrainResult> {
    const { store } = this.deps
    const idle: DrainResult = { pushed: 0, failed: 0, failedIds: [], parked: false, remaining: 0 }

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
      //
      // It has to SAY so. This was the one branch in this method that returned
      // without a word, and the two secrets fail differently: a pull only needs
      // the vault key, so a device missing just the signing key pulls forever,
      // looks healthy, and silently never pushes a single row. That state cost
      // an afternoon to find from the server side.
      const remaining = await store.pendingCount()
      if (remaining > 0) {
        log.warn('Outbox cannot drain: a push secret is missing', {
          remaining,
          hasVaultKey: vaultKey !== null,
          hasSigningKey: signingSecretKey !== null
        })
      }
      return { ...idle, remaining }
    }

    const rows = await store.claimBatch(CLAIM_LIMIT)
    if (rows.length === 0) return idle

    let pushed = 0
    let failed = 0
    const failedIds: number[] = []

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
      failedIds.push(...result.failedIds)
      if (result.stop) {
        return { pushed, failed, failedIds, parked: true, remaining: await store.pendingCount() }
      }
    }

    for (let i = 0; i < recordRows.length; i += RECORD_BATCH_LIMIT) {
      const chunk = recordRows.slice(i, i + RECORD_BATCH_LIMIT)
      const result = await this.pushRecords(chunk, vaultKey, signingSecretKey)
      pushed += result.pushed
      failed += result.failed
      failedIds.push(...result.failedIds)
      if (result.stop) {
        return { pushed, failed, failedIds, parked: true, remaining: await store.pendingCount() }
      }
    }

    const remaining = await store.pendingCount()
    logOutboxDepth(remaining)
    return { pushed, failed, failedIds, parked: false, remaining }
  }

  private async pushCrdt(
    noteId: string,
    rows: OutboxRow[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array
  ): Promise<{ pushed: number; failed: number; failedIds: number[]; stop: boolean }> {
    const usable = rows.filter((r) => r.payload !== null)
    const empty = rows.filter((r) => r.payload === null)
    if (empty.length > 0) await this.deps.store.complete(empty.map((r) => r.id))
    if (usable.length === 0) return { pushed: 0, failed: 0, failedIds: [], stop: false }

    // Encrypt once, then let the shared planner decide what fits. It enforces
    // both wire budgets the server has: the per-update D1 row cap and the
    // per-request body cap. Anything it cannot place comes back as `oversized`
    // rather than being silently dropped.
    let encrypted: string[]
    try {
      encrypted = usable.map((row) =>
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
    } catch (err) {
      return this.handleFailure(usable, err)
    }

    const plan = planCrdtUpdatePush(encrypted)
    const oversizedSet = new Set(plan.oversized)
    const incremental = usable.filter((_, index) => !oversizedSet.has(encrypted[index]))
    const byPayload = new Map(encrypted.map((payload, index) => [payload, usable[index]]))

    let pushed = 0
    // Rows that have already landed. Failing them alongside the ones that did
    // not would give completed rows a backoff they no longer have, and would
    // report a `failed` count that includes work which actually succeeded.
    const landed = new Set<number>()

    for (const request of plan.requests) {
      // The planner bounds bytes; this bounds COUNT, which is a separate cap.
      for (let i = 0; i < request.length; i += CRDT_UPDATES_PER_REQUEST) {
        const updates = request.slice(i, i + CRDT_UPDATES_PER_REQUEST)
        const rowsInChunk = updates.map((payload) => byPayload.get(payload)!).filter(Boolean)
        try {
          await seamJsonRequest<{ sequences: number[] }>(this.deps.httpCtx(), {
            method: 'POST',
            path: '/sync/crdt/updates',
            body: { noteId, updates }
          })
          await this.deps.store.complete(rowsInChunk.map((r) => r.id))
          for (const row of rowsInChunk) landed.add(row.id)
          pushed += rowsInChunk.length
        } catch (err) {
          const remaining = incremental.filter((row) => !landed.has(row.id))
          // The oversized rows go with them. Returning without touching those
          // leaves them neither snapshot-pushed nor failed: no backoff, and
          // re-claimed and re-encrypted on every single drain.
          const oversizedRows = plan.oversized
            .map((payload) => byPayload.get(payload)!)
            .filter(Boolean)
          const outcome = await this.handleFailure([...remaining, ...oversizedRows], err)
          return {
            pushed,
            failed: outcome.failed,
            failedIds: outcome.failedIds,
            stop: outcome.stop
          }
        }
      }
    }

    if (plan.oversized.length > 0) {
      const oversizedRows = plan.oversized.map((payload) => byPayload.get(payload)!).filter(Boolean)
      const outcome = await this.pushSnapshot(noteId, oversizedRows, vaultKey, signingSecretKey)
      return {
        pushed: pushed + outcome.pushed,
        failed: outcome.failed,
        failedIds: outcome.failedIds,
        stop: outcome.stop
      }
    }

    return { pushed, failed: 0, failedIds: [], stop: false }
  }

  /**
   * Replace a note's server-side state with a full snapshot.
   *
   * The escape hatch for an update no incremental request can carry — a huge
   * paste, typically. The snapshot contains everything those updates said, so
   * their rows are completed with it; leaving them queued would retry a
   * request that can only ever 413.
   */
  private async pushSnapshot(
    noteId: string,
    rows: OutboxRow[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array
  ): Promise<{ pushed: number; failed: number; failedIds: number[]; stop: boolean }> {
    const encodeDocSnapshot = this.deps.encodeDocSnapshot
    const ids = rows.map((r) => r.id)
    if (!encodeDocSnapshot) {
      await this.deps.store.fail(ids, 'update too large and no snapshot source')
      return { pushed: 0, failed: ids.length, failedIds: ids, stop: false }
    }

    try {
      const state = await encodeDocSnapshot(noteId)
      if (!state) {
        await this.deps.store.fail(ids, 'update too large and doc unavailable')
        return { pushed: 0, failed: ids.length, failedIds: ids, stop: false }
      }
      const snapshot = this.deps.crypto.toBase64(
        encryptCrdtUpdatePacked(this.deps.crypto, state, vaultKey, noteId, signingSecretKey)
      )
      await seamJsonRequest<{ sequenceNum: number }>(this.deps.httpCtx(), {
        method: 'POST',
        path: '/sync/crdt/snapshot',
        body: { noteId, snapshot }
      })
      await this.deps.store.complete(rows.map((r) => r.id))
      log.info('Pushed a full snapshot for an oversized update', { noteId, rows: rows.length })
      return { pushed: rows.length, failed: 0, failedIds: [], stop: false }
    } catch (err) {
      return this.handleFailure(rows, err)
    }
  }

  private async pushRecords(
    rows: OutboxRow[],
    vaultKey: Uint8Array,
    signingSecretKey: Uint8Array
  ): Promise<{ pushed: number; failed: number; failedIds: number[]; stop: boolean }> {
    const items: PushItem[] = []
    const rowsById = new Map<string, number[]>()
    // Rows this call has already completed or failed. Passing them to
    // `handleFailure` again would double their attempt count and double-count
    // the failure in the result.
    const settled = new Set<number>()

    // Collapse to ONE push item per item id, using the NEWEST row.
    //
    // Rows carry the whole payload as it stood at enqueue time, so the latest
    // row already contains everything the earlier ones said — and a delete,
    // being last, correctly wins over a preceding update. Sending several
    // items with the same id in one batch is also what made a mixed
    // accept/reject response delete the rejected rows: the server answers per
    // ID, so two rows sharing an id cannot be told apart afterwards.
    const newestByItem = new Map<string, OutboxRow>()
    for (const row of rows) {
      const list = rowsById.get(row.itemId) ?? []
      list.push(row.id)
      rowsById.set(row.itemId, list)
      const seen = newestByItem.get(row.itemId)
      if (!seen || row.id > seen.id) newestByItem.set(row.itemId, row)
    }

    for (const row of newestByItem.values()) {
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
        const ids = rowsById.get(row.itemId) ?? [row.id]
        await this.deps.store.complete(ids)
        for (const id of ids) settled.add(id)
        rowsById.delete(row.itemId)
        continue
      }

      const clock = (payload.clock as VectorClock | undefined) ?? {}
      let pushItem: PushItem
      try {
        ;({ pushItem } = await encryptRecordForPush(this.deps.crypto, {
          id: row.itemId,
          type,
          operation,
          content: new TextEncoder().encode(JSON.stringify(payload)),
          vaultKey,
          signingSecretKey,
          signerDeviceId: this.deps.deviceId(),
          clock,
          ...(operation === 'delete' ? { deletedAt: Date.now() } : {})
        }))
      } catch (err) {
        // Encryption failing is a property of THIS item, not of the batch, and
        // letting it escape leaves the rows neither failed nor completed — they
        // are re-claimed on every pass and wedge every later record push behind
        // them. Size is the one failure that can never succeed on retry, so it
        // is retired loudly rather than retried forever.
        const message = err instanceof Error ? err.message : String(err)
        const ids = rowsById.get(row.itemId) ?? [row.id]
        if (err instanceof ItemTooLargeError) {
          log.error('Item is too large to sync; dropping its queue rows', {
            itemId: row.itemId,
            error: message
          })
          await this.deps.store.complete(ids)
        } else {
          log.warn('Encrypting a queued item failed; backing off', {
            itemId: row.itemId,
            error: message
          })
          await this.deps.store.fail(ids, message)
        }
        for (const id of ids) settled.add(id)
        rowsById.delete(row.itemId)
        continue
      }
      items.push(pushItem)
    }

    if (items.length === 0) return { pushed: 0, failed: 0, failedIds: [], stop: false }

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
        const ids = [...rowsById.values()].flat()
        await this.deps.store.fail(ids, 'unparseable push response')
        return { pushed: 0, failed: ids.length, failedIds: ids, stop: false }
      }

      const acceptedIds: number[] = []
      for (const id of parsed.data.accepted) acceptedIds.push(...(rowsById.get(id) ?? []))
      await this.deps.store.complete(acceptedIds)

      const rejectedIds: number[] = []
      for (const rejection of parsed.data.rejected) {
        rejectedIds.push(...(rowsById.get(rejection.id) ?? []))
        log.warn('Push item rejected', { itemId: rejection.id, reason: rejection.reason })
      }
      if (rejectedIds.length > 0) await this.deps.store.fail(rejectedIds, 'server rejected item')

      return {
        pushed: acceptedIds.length,
        failed: rejectedIds.length,
        failedIds: rejectedIds,
        stop: false
      }
    } catch (err) {
      return this.handleFailure(
        rows.filter((row) => !settled.has(row.id)),
        err
      )
    }
  }

  /**
   * 403/426 are policy, not failure: they flip the app into read-only, park
   * the queue and stop the pass. Anything else is a transient the backoff owns.
   */
  private async handleFailure(
    rows: OutboxRow[],
    err: unknown
  ): Promise<{ pushed: number; failed: number; failedIds: number[]; stop: boolean }> {
    const message = err instanceof Error ? err.message : String(err)

    // Only the two POLICY codes park. A 403 for any other reason — a revoked
    // device, a quota refusal — is a plain failure: parking on it would set no
    // read-only state, record no backoff and surface nothing, so the outbox
    // would simply stop draining with no symptom at all.
    const policyCode =
      err instanceof SyncServerError && POLICY_REJECTION_CODES.has(err.serverError ?? '')
        ? err.serverError!
        : null

    if (policyCode) {
      applyWriteRejection(policyCode, extractMinVersion(err as SyncServerError))
      // No `fail()`: parked rows must not accumulate backoff for a condition
      // they did not cause, or the first pass after the switch clears sits idle.
      log.warn('Write refused by server policy; outbox parked', { code: policyCode })
      return { pushed: 0, failed: 0, failedIds: [], stop: true }
    }

    const ids = rows.map((r) => r.id)
    await this.deps.store.fail(ids, message)
    log.warn('Outbox push failed; backing off', { rows: ids.length, error: message })
    return { pushed: 0, failed: ids.length, failedIds: ids, stop: false }
  }
}

function extractMinVersion(err: SyncServerError): string | undefined {
  // The server's error envelope is `{ error: { code, message, minVersion? } }`;
  // the transport flattens the code onto `serverError` and leaves the rest in
  // the message, so this is a best-effort read rather than a parse.
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(err.message)
  return match?.[1]
}
