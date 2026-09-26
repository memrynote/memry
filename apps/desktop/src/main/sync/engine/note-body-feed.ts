import * as Y from 'yjs'
import {
  NoteBodyChangeSchema,
  type NoteBodyChange,
  type RecordChangesResponse
} from '@memry/contracts/sync-api'
import type { CrdtPayloadForDecrypt } from '@memry/sync-client/worker-protocol'
import { createLogger } from '../../lib/logger'
import { engineAuthRetryDeps, withAuthRetry } from '../auth-retry'
import { fetchCrdtSnapshot, getFromServer, NetworkError, SyncServerError } from '../http-client'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import type { CrdtProvider } from '../crdt-provider'
import { isKnownNote, landNoteBody } from '../note-body-apply'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { SchemaInvalidLedger } from './schema-invalid-ledger'
import {
  NOTE_BODY_ITEM_TYPE,
  NOTE_BODY_LEGACY_SWEEP_PENDING,
  SYNC_STATE_KEYS,
  type SyncContext
} from './sync-context'
import type { SyncStateManager } from './sync-state-manager'

const log = createLogger('NoteBodyFeed')

/** Ref and snapshot GETs in flight at once for one page. */
const NOTE_BODY_FETCH_CONCURRENCY = 4

/**
 * Ref and snapshot GETs one page may spend of the `crdt_pull` budget it
 * shares with the record pages' CRDT batch. Entries past it are owed to the
 * paced sweep, which charges its own GETs (review A-M2, B-M1).
 */
export const NOTE_BODY_FETCHES_PER_PAGE = 16

export interface FeedBody {
  noteId: string
  /** The decrypted Yjs update, already decoded once. */
  update: Uint8Array
  /** Set for a snapshot: recorded in the watermark once it landed. */
  snapshot?: { sequenceNum: number; revision: string }
}

/**
 * A changes page's note bodies (#2297), fetched and verified before the page's
 * last slice opens its transaction.
 */
export interface PageNoteBodies {
  bodies: FeedBody[]
  /** Notes with an entry this build could not parse or verify: ledgered and owed. */
  refused: string[]
  /** Notes whose entry was not fetched or not current (transport, budget, pruned): owed a whole-body pull. */
  owed: string[]
  /**
   * Lowest entry cursor of each note on the page, for its debt's
   * `lowest_cursor` (#2297). `null` when an entry's cursor could not be read.
   */
  cursors?: Map<string, number | null>
  /**
   * Notes whose entries were skipped because their record is on the page, with
   * the lowest such entry cursor. Owed in the page transaction, so a record
   * that fails to apply still leaves its note owed and flagged (#2297 B-H1).
   */
  skippedForRecord?: Map<string, number | null>
  /** Every body failed to decrypt and the account key check says why; the cursor holds. */
  keyStop?: 'mismatch' | 'transition'
}

interface Packed {
  noteId: string
  bytes: Uint8Array
  signerDeviceId: string
  snapshot?: FeedBody['snapshot']
}

type Fetched = Packed | 'skipped' | 'owed' | 'refused'

/** One page's GET budget; `stopped` after the first transport failure. */
interface PageFetches {
  left: number
  stopped: boolean
}

export interface NoteBodyFeedDeps {
  ctx: SyncContext
  stateManager: SyncStateManager
  ledger: SchemaInvalidLedger
  /** A getter: the engine wires the coordinator after the pull coordinator exists. */
  crdtSync: () => CrdtSyncCoordinator
  resolveDeviceKey(deviceId: string): Promise<Uint8Array | null>
  /** The legacy key was deleted: a sweep queued before this covers nothing new. */
  onLegacySweepReset(): void
}

/**
 * Note bodies from GET /sync/changes on desktop (protocol 07 §7.17.5). Per
 * page: `fetchPage` before any slice transaction, `recordInPage` inside the
 * last slice's transaction, `land` after its commit and note files. Landing is
 * post-commit work, so LAST_CURSOR waits for it (#2294): a crash before it
 * re-pulls the page. Nothing is kept on disk between the two.
 */
export class NoteBodyFeed {
  constructor(private deps: NoteBodyFeedDeps) {}

  /**
   * `null` when note_body was not declared for this page, or the page has no
   * `noteBodies` array: a server that does not serve bodies in the feed. A bad
   * entry is refused or owed per entry and never fails the page (05 §5.14),
   * transport errors included; only an abort throws.
   *
   * Nothing is fetched for a note with no row here, nor for a note whose
   * record is on this page: the record pulls that note's whole body, and a
   * body for a note that never gets a row is dropped (review A-M2, B-M1).
   */
  async fetchPage(
    changes: RecordChangesResponse,
    session: { accessJwt: string },
    vaultKey: Uint8Array,
    declared: boolean
  ): Promise<PageNoteBodies | null> {
    if (!declared) {
      // A run from cursor 0 does not declare note_body, yet its pages move
      // LAST_CURSOR past body rows it never serves. A snapshot claim of that
      // cursor would cover them (#2299, 07 §7.7.1), so the run re-arms the
      // legacy sweep exactly as a page from a server that stopped serving does.
      this.trackNegotiation(false)
      return null
    }
    this.trackNegotiation(Array.isArray(changes.noteBodies))
    if (!Array.isArray(changes.noteBodies)) return null
    const page: PageNoteBodies = {
      bodies: [],
      refused: [],
      owed: [],
      cursors: new Map(),
      skippedForRecord: new Map()
    }
    const provider = this.deps.ctx.deps.crdtProvider
    if (!provider) return page

    const pageRecords = new Set(
      changes.items.filter((i) => i.type === 'note' || i.type === 'journal').map((i) => i.id)
    )
    const wanted = (noteId: string): boolean => {
      if (pageRecords.has(noteId) || provider.isNoteLocalOnly(noteId)) return false
      if (isKnownNote(this.deps.ctx.deps.db, noteId)) return true
      // Dropped with no row, and the cursor moves past it. A note or journal
      // (deterministic ids) created here later lacks this body, so it may not
      // claim that cursor until a whole-body pull merges it (#2299, B-L4).
      provider.withholdClaimUntilPulled(noteId)
      return false
    }
    const parsed: NoteBodyChange[] = []
    const lowestInto = (
      cursors: Map<string, number | null>,
      noteId: string,
      cursor: number | null
    ): void => {
      const held = cursors.get(noteId)
      const lowest = held === null || cursor === null ? null : Math.min(held ?? cursor, cursor)
      cursors.set(noteId, lowest)
    }
    const noteCursor = (noteId: string, cursor: number | null): void =>
      lowestInto(page.cursors!, noteId, cursor)
    for (const raw of changes.noteBodies) {
      const result = NoteBodyChangeSchema.safeParse(raw)
      const skippedId = result.success ? result.data.noteId : (raw as { noteId?: unknown })?.noteId
      if (
        typeof skippedId === 'string' &&
        pageRecords.has(skippedId) &&
        !provider.isNoteLocalOnly(skippedId)
      ) {
        lowestInto(page.skippedForRecord!, skippedId, result.success ? result.data.cursor : null)
      }
      if (result.success) {
        if (wanted(result.data.noteId)) {
          parsed.push(result.data)
          noteCursor(result.data.noteId, result.data.cursor)
        }
        continue
      }
      const noteId = (raw as { noteId?: unknown } | null)?.noteId
      if (typeof noteId !== 'string' || noteId.length === 0) {
        log.error('Dropped a change-feed note body with no noteId')
      } else if (wanted(noteId)) {
        page.refused.push(noteId)
        noteCursor(noteId, null)
      }
    }
    // Every snapshot GET returns the note's current snapshot, so one per note:
    // the newest entry, whose revision is the one the skip compares (A-M1).
    const newestSnapshot = new Map<string, number>()
    for (const body of parsed) {
      if (body.op === 'snapshot' && body.cursor > (newestSnapshot.get(body.noteId) ?? 0)) {
        newestSnapshot.set(body.noteId, body.cursor)
      }
    }
    const entries = parsed.filter(
      (body) => body.op !== 'snapshot' || newestSnapshot.get(body.noteId) === body.cursor
    )
    // An in-memory provider cannot hold a body; the CRDT pull merges into its docs.
    if (!provider.hasPersistence()) {
      page.owed.push(...entries.map((body) => body.noteId))
      return page
    }

    const fetches: PageFetches = { left: NOTE_BODY_FETCHES_PER_PAGE, stopped: false }
    const fetched = await mapBounded(entries, NOTE_BODY_FETCH_CONCURRENCY, (body) =>
      this.fetchEntry(body, session, provider, fetches)
    )
    const packed: Packed[] = []
    for (const [i, result] of fetched.entries()) {
      if (result === 'refused') page.refused.push(entries[i].noteId)
      else if (result === 'owed') page.owed.push(entries[i].noteId)
      else if (result !== 'skipped') packed.push(result)
    }

    const { decrypted, cryptoFailures, refused } = await this.decrypt(packed, vaultKey)
    page.refused.push(...refused)
    if (packed.length > 0 && cryptoFailures === packed.length) {
      page.keyStop = await this.accountKeyStop(cryptoFailures)
      if (page.keyStop) return { bodies: [], refused: [], owed: [], keyStop: page.keyStop }
    }
    page.bodies = decrypted
    return page
  }

  /**
   * Inside a slice's transaction, after its records applied: owe the skipped
   * bodies of the records this slice applied, and take them off the page's
   * map, so the slice's own CRDT batch settles them (#2297 round 2 b-M2).
   */
  oweSkippedForRecords(
    skipped: Map<string, number | null> | undefined,
    applied: ReadonlyArray<{ id: string }>
  ): void {
    if (!skipped) return
    const due = applied.map((item) => item.id).filter((noteId) => skipped.has(noteId))
    for (const noteId of this.withRows(due)) {
      this.deps.crdtSync().oweSkippedBody(noteId, skipped.get(noteId) ?? null)
    }
    for (const noteId of due) skipped.delete(noteId)
  }

  /**
   * Inside the last slice transaction, after its records applied and before
   * any cursor write. Only a note that still has a row is ledgered or owed: a
   * pull of a deleted one would let the write-back re-create it (A-H1, B-H1).
   */
  recordInPage(page: PageNoteBodies): void {
    this.refuse(page, page.refused, 'feed_refused')
    for (const noteId of this.withRows(page.owed)) {
      this.deps.crdtSync().addPendingPull(noteId, 'feed_owed', page.cursors?.get(noteId) ?? null)
    }
    // What no slice applied a record for (filtered, quarantined, schema
    // invalid, failed): no queued pull, and the note stays owed and flagged.
    const skipped = page.skippedForRecord ?? new Map<string, number | null>()
    for (const noteId of this.withRows([...skipped.keys()])) {
      this.deps.crdtSync().oweSkippedBody(noteId, skipped.get(noteId) ?? null)
    }
  }

  /**
   * After the page committed and its note files landed, before the cursor
   * write. A document whose landing rejects is refused like an undecryptable
   * entry: ledgered, flagged unmerged and owed a whole-body pull. An abort
   * (vault close or switch) stops the landing and refuses nothing: the cursor
   * holds, so the page is pulled again (B-L2).
   */
  async land(page: PageNoteBodies): Promise<void> {
    const provider = this.deps.ctx.deps.crdtProvider
    if (!provider || page.bodies.length === 0) return
    const byNote = new Map<string, FeedBody[]>()
    for (const body of page.bodies) {
      byNote.set(body.noteId, [...(byNote.get(body.noteId) ?? []), body])
    }

    const aborted = (): boolean => this.deps.ctx.abortController?.signal.aborted === true
    const failed: string[] = []
    for (const [noteId, bodies] of byNote) {
      if (aborted()) return
      try {
        const merged = await landNoteBody(
          {
            provider,
            isKnownNote: (id) => isKnownNote(this.deps.ctx.deps.db, id),
            onMissingBase: (id) => this.deps.crdtSync().addPendingPull(id, 'missing_base')
          },
          noteId,
          bodies.map((body) => body.update)
        )
        // A row deleted while the doc opened: dropped like one never there.
        if (!merged && !isKnownNote(this.deps.ctx.deps.db, noteId)) {
          provider.withholdClaimUntilPulled(noteId)
        }
        // Only a snapshot the doc now holds: a watermark for one it does not
        // makes the CRDT pull skip the baseline this note is owed.
        const snapshot = [...bodies].reverse().find((body) => body.snapshot)?.snapshot
        if (merged && snapshot) await recordMergedSnapshot(provider, noteId, snapshot)
      } catch (err) {
        if (aborted()) return
        log.warn('Change-feed note body did not reach the CRDT store', {
          noteId,
          error: err instanceof Error ? err.message : String(err)
        })
        failed.push(noteId)
      }
    }
    this.refuse(page, failed, 'land_failed')
  }

  /**
   * Heal a refused body by merging the note's whole server body; true resolves
   * the ledger entry. A note with no row here, or a local-only one, is resolved
   * without a pull: merging it would arm a write-back that re-creates a deleted
   * note, and a local-only note takes no server state (review A-H1).
   */
  async heal(noteId: string, token: string, vaultKey: Uint8Array): Promise<boolean> {
    const provider = this.deps.ctx.deps.crdtProvider
    if (!provider || !isKnownNote(this.deps.ctx.deps.db, noteId)) return true
    if (provider.isNoteLocalOnly(noteId)) return true
    const crdtSync = this.deps.crdtSync()
    const merged = await crdtSync.applyCrdtIncrementals(noteId, token, vaultKey)
    // `true` with an update it could not verify still leaves the note flagged.
    return merged && !crdtSync.hasUnmergedRemoteState(noteId)
  }

  private refuse(
    page: PageNoteBodies,
    refused: string[],
    reason: 'feed_refused' | 'land_failed'
  ): void {
    const noteIds = this.withRows(refused)
    if (noteIds.length === 0) return
    this.deps.ledger.record(
      noteIds.map((id) => ({ id, type: NOTE_BODY_ITEM_TYPE })),
      'envelope'
    )
    for (const noteId of noteIds) {
      this.deps.crdtSync().addPendingPull(noteId, reason, page.cursors?.get(noteId) ?? null)
    }
  }

  private withRows(noteIds: string[]): string[] {
    return [...new Set(noteIds)].filter((id) => isKnownNote(this.deps.ctx.deps.db, id))
  }

  /**
   * The first page with a `noteBodies` array proves the server serves bodies:
   * from then on rows below this device's cursor, and rows with no cursor, are
   * never served, so the next full sync owes one sweep of every note. A page
   * without the array while the key is set means the server stopped serving
   * bodies (a rollback past #2295); clearing the key re-arms the sweep for the
   * next negotiated page, which is what covers rows written in between.
   */
  private trackNegotiation(served: boolean): void {
    const { stateManager } = this.deps
    const recorded = stateManager.getStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)
    if (served && recorded === undefined) {
      stateManager.setStateValue(
        SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP,
        NOTE_BODY_LEGACY_SWEEP_PENDING
      )
    } else if (!served && recorded !== undefined) {
      stateManager.deleteStateValue(SYNC_STATE_KEYS.NOTE_BODY_LEGACY_SWEEP)
      this.deps.onLegacySweepReset()
    }
  }

  /**
   * A skipped snapshot (revision already merged) is 'skipped'. A pruned ref
   * update and a snapshot with no blob are 'owed': a covering snapshot may sit
   * on a later page the run never reaches (§7.17.2), so the note is flagged and
   * pulled whole. So is an entry past the page's GET budget, and every entry
   * from the first transport failure on: one attempt each, and a rate limit,
   * an outage or an expired session says nothing about the entry (A-M3,
   * B-M2). Any other failure is 'refused'.
   */
  private async fetchEntry(
    body: NoteBodyChange,
    session: { accessJwt: string },
    provider: CrdtProvider,
    fetches: PageFetches
  ): Promise<Fetched> {
    const signal = this.deps.ctx.abortController?.signal
    const authed = <T>(request: (token: string) => Promise<T>): Promise<T> =>
      withAuthRetry(
        request,
        session.accessJwt,
        engineAuthRetryDeps(this.deps.ctx.deps),
        (fresh) => {
          session.accessJwt = fresh
        }
      )
    const spend = (): boolean => !fetches.stopped && fetches.left-- > 0
    try {
      if (body.op === 'snapshot') {
        const held = await provider.getSnapshotWatermark(body.noteId)
        if (held?.snapshotRevision === body.revision) return 'skipped'
        if (!spend()) return 'owed'
        const snapshot = await authed((token) =>
          fetchCrdtSnapshot(body.noteId, token, { signal, maxRetries: 0 })
        )
        if (!snapshot) return 'owed'
        return {
          noteId: body.noteId,
          bytes: snapshot.snapshot,
          signerDeviceId: snapshot.signerDeviceId,
          ...(snapshot.revision
            ? { snapshot: { sequenceNum: snapshot.sequenceNum, revision: snapshot.revision } }
            : {})
        }
      }
      if (body.data) {
        return {
          noteId: body.noteId,
          bytes: new Uint8Array(Buffer.from(body.data, 'base64')),
          signerDeviceId: body.signerDeviceId
        }
      }
      if (!spend()) return 'owed'
      const value = await authed((token) =>
        getFromServer<{
          updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string }>
        }>(
          `/sync/crdt/updates?note_id=${encodeURIComponent(body.noteId)}` +
            `&since=${body.sequenceNum - 1}&limit=1`,
          token,
          undefined,
          { signal }
        )
      )
      const row = value.updates[0]
      if (row?.sequenceNum !== body.sequenceNum) return 'owed'
      return {
        noteId: body.noteId,
        bytes: new Uint8Array(Buffer.from(row.data, 'base64')),
        signerDeviceId: row.signerDeviceId
      }
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err
      const transport =
        err instanceof NetworkError ||
        (err instanceof SyncServerError &&
          (err.statusCode === 401 || err.statusCode === 429 || err.statusCode >= 500))
      log.warn('Change-feed note body could not be fetched', {
        noteId: body.noteId,
        op: body.op,
        transport,
        error: err instanceof Error ? err.message : String(err)
      })
      if (!transport) return 'refused'
      fetches.stopped = true
      return 'owed'
    }
  }

  /**
   * Resolve signer keys, decrypt (on the crypto worker when it runs) and
   * decode each body once. A body Yjs cannot decode is refused and never
   * stored: raw bytes in the store would break every later load of the doc.
   */
  private async decrypt(
    packed: Packed[],
    vaultKey: Uint8Array
  ): Promise<{ decrypted: FeedBody[]; cryptoFailures: number; refused: string[] }> {
    const refused: string[] = []
    const keys = new Map<string, Uint8Array | null>()
    for (const signer of new Set(packed.map((p) => p.signerDeviceId))) {
      try {
        keys.set(signer, await this.deps.resolveDeviceKey(signer))
      } catch (err) {
        log.warn('Could not resolve a change-feed body signer', { signer, error: err })
        keys.set(signer, null)
      }
    }
    const verifiable = packed.filter((p) => {
      if (keys.get(p.signerDeviceId)) return true
      refused.push(p.noteId)
      return false
    })

    const updates = await decryptPayloads(this.deps.ctx, verifiable, vaultKey, keys)
    const decrypted: FeedBody[] = []
    let cryptoFailures = 0
    for (const [i, p] of verifiable.entries()) {
      const update = updates[i]
      if (!update) {
        cryptoFailures++
        refused.push(p.noteId)
        continue
      }
      try {
        Y.decodeUpdate(update)
      } catch {
        log.warn('Change-feed note body is not a Yjs update', { noteId: p.noteId })
        refused.push(p.noteId)
        continue
      }
      decrypted.push({ noteId: p.noteId, update, ...(p.snapshot ? { snapshot: p.snapshot } : {}) })
    }
    return {
      decrypted,
      cryptoFailures: cryptoFailures + (packed.length - verifiable.length),
      refused
    }
  }

  /**
   * Every body of the page failed to decrypt: the same account-key check
   * records get. A mismatch or a key mid-swap holds the cursor and ledgers
   * nothing; anything else is per-entry corruption.
   */
  private async accountKeyStop(failed: number): Promise<PageNoteBodies['keyStop']> {
    const { ctx, stateManager } = this.deps
    const keyCheck = await ctx.deps.checkAccountKey?.()
    if (keyCheck === 'transition') return 'transition'
    if (keyCheck !== 'mismatch') return undefined
    ctx.lastError = `${failed} note body update(s) could not be decrypted — possible vault key mismatch.`
    ctx.lastErrorInfo = { category: 'crypto_failure', message: ctx.lastError, retryable: false }
    stateManager.setState('error')
    ctx.deps.onVaultKeyMismatch?.()
    return 'mismatch'
  }
}

/** Decrypted bytes aligned with `packed`; `undefined` where the payload failed. */
async function decryptPayloads(
  ctx: SyncContext,
  packed: Packed[],
  vaultKey: Uint8Array,
  keys: Map<string, Uint8Array | null>
): Promise<Array<Uint8Array | undefined>> {
  if (packed.length === 0) return []
  const bridge = ctx.deps.workerBridge
  if (bridge?.isRunning) {
    const payloads: CrdtPayloadForDecrypt[] = packed.map((p, index) => ({
      index,
      noteId: p.noteId,
      data: p.bytes,
      signerDeviceId: p.signerDeviceId
    }))
    const signerKeys: Record<string, string> = {}
    for (const p of packed) {
      signerKeys[p.signerDeviceId] = Buffer.from(keys.get(p.signerDeviceId)!).toString('base64')
    }
    try {
      const { results } = await bridge.decryptCrdtBatch(payloads, vaultKey, signerKeys)
      const byIndex = new Map(results.map((r) => [r.index, r.update]))
      return packed.map((_p, index) => byIndex.get(index))
    } catch (err) {
      // Transport or lifecycle only; per-item verdicts arrive in-band above.
      log.warn('CRDT worker decrypt unavailable — falling back to main thread', { error: err })
    }
  }
  return packed.map((p) => {
    try {
      return decryptCrdtUpdate(p.bytes, vaultKey, p.noteId, keys.get(p.signerDeviceId)!)
    } catch {
      return undefined
    }
  })
}

/**
 * The landed snapshot is in the store, so the watermark says so: the next
 * snapshot entry with the same revision, and the CRDT pull's baseline probe,
 * skip the download.
 */
async function recordMergedSnapshot(
  provider: CrdtProvider,
  noteId: string,
  snapshot: NonNullable<FeedBody['snapshot']>
): Promise<void> {
  const held = await provider.getSnapshotWatermark(noteId)
  await provider.putSnapshotWatermark(noteId, {
    appliedSequence: Math.max(held?.appliedSequence ?? 0, snapshot.sequenceNum),
    snapshotRevision: snapshot.revision
  })
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
