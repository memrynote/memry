import * as Y from 'yjs'
import fsp from 'fs/promises'
import { BrowserWindow } from 'electron'
import { CRDT_EVENTS, CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  getDatabase,
  getIndexDatabase,
  isDatabaseInitialized,
  type DataDb
} from '../database/client'
import { getOrCreateVaultUuid } from '../agent/storage/vault-id'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { crdtBodyDebtStore } from './engine/crdt-body-debts'
import { getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import type { NoteBodyOutbox } from './note-body-outbox'
import { NOTE_BODY_FULL_STATE_PAYLOAD, SyncQueueManager } from '@memry/sync-client/queue'
import { MicrotaskBatchBroadcaster } from '@memry/sync-client/microtask-batch-broadcaster'
import { parallelWithLimit } from '@memry/sync-client/concurrency'
import { MAX_CRDT_SNAPSHOT_BATCH_ENTRIES } from '@memry/sync-client/crdt-payload'
import {
  scheduleWriteback,
  cancelWriteback,
  flushPendingWritebacks,
  recordNetworkUpdate,
  resetWritebackState
} from './crdt-writeback'
import { openCrdtPersistence, type CrdtPersistence } from './crdt-persistence'
import {
  readSnapshotWatermark,
  writeSnapshotWatermark,
  SNAPSHOT_WATERMARK_META_KEY,
  type CrdtSnapshotWatermark
} from '@memry/sync-client/crdt-snapshot-watermark'
import { recordCrdtPersistenceOutcome } from '../store'
import { prepareVaultCrdtStore } from './crdt-store-path'
import { reconcileCrdtStoreEpoch } from './crdt-store-epoch'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { generateContentHash, parseNote } from '../vault/frontmatter'
import { markdownToYFragment, repairEmptyBlockIds } from './blocknote-converter'
import { compactYDoc } from '@memry/sync-client/crdt-compact-utils'
import { isBinaryFileType } from '@memry/shared/file-types'
import { classifyMarkdownContent, classifyMarkdownStat } from '@memry/shared/markdown-class'
import {
  CRITIC_MARKUP_MARKS_ARRAY,
  LINK_REFERENCE_DEFINITIONS_ARRAY,
  LINK_REFERENCE_USAGES_ARRAY,
  MARKDOWN_SOURCE_MAP
} from '@memry/shared'

const log = createLogger('CrdtProvider')

/** A reserved y-leveldb meta doc: never in the doc list, never opened (#2421). */
const OWED_COMPACTIONS_DOC = '__memry_owed_compactions__'
const OWED_COMPACTIONS_KEY = 'owedCompactions'

interface IpcOrigin {
  source: 'ipc'
  windowId: number
}

const ORIGIN_NETWORK = 'network'
export const ORIGIN_LOCAL = 'local'
const SIZE_CHECK_INTERVAL_MS = 60_000
const ENCODED_SIZE_COMPACTION_THRESHOLD = 1024 * 1024
const ACCUMULATED_BYTES_RECHECK_THRESHOLD = 512 * 1024
const DEFAULT_INACTIVE_DOC_LIMIT = 32

/**
 * What a snapshot push may claim about the state it carries (#2299, protocol 07
 * §7.7). Read in the same synchronous step as the encode it describes: a
 * change-feed page can land bodies and move LAST_CURSOR during any later await,
 * and a cursor read after the encode would claim rows the state does not hold.
 */
export interface SnapshotCoverage {
  /** The note held tracked, unmerged server state at the encode: never the pruning route. */
  unmerged: boolean
  /** The feed cursor through which the state holds every note_body row; absent claims nothing. */
  coversThrough?: number
  /**
   * The server snapshot revision this doc had merged (or pushed) before the
   * encode. Read BEFORE the bytes: a revision merged after them is not in them.
   */
  baseRevision?: string
}

/**
 * The coverage of the next push of a note. `heldRevision` is the snapshot
 * revision the doc holds, read before the encode.
 */
export type SnapshotCoverageReader = (
  noteId: string,
  heldRevision: string | undefined
) => SnapshotCoverage

/** A snapshot push the server refused as not covering its stored snapshot (#2299). */
export interface SnapshotRefusal {
  /** The refusing snapshot's feed cursor, when the server named one. */
  cursor: number | null
  /** The refused push carried a claim. */
  claimed: boolean
  /** The held snapshot revision the refused push was encoded against. */
  baseRevision?: string
}

const NO_COVERAGE: SnapshotCoverageReader = () => ({ unmerged: false })

/** The pre-encode read `encodeForPush` needs; only `readPushBase` makes one. */
interface PushBase {
  readonly noteId: string
  readonly revision: string | undefined
}

export type SnapshotPushFn = (
  noteId: string,
  state: Uint8Array,
  coverage: SnapshotCoverage
) => Promise<void>

/** One note's full document state, ready to be encrypted and sent. */
export interface SnapshotBatchEntry {
  noteId: string
  state: Uint8Array
  coverage: SnapshotCoverage
}

/**
 * Send several notes' full states in as few requests as the server allows.
 *
 * Total by contract: it never rejects, and the map it returns has an entry for
 * every noteId it was handed. `false` means "not on the server" — a per-note
 * rejection, a transport failure, an old server whose fallback also failed —
 * and the provider treats every one of them exactly as it treats a failed
 * single-note push: counters restored, note still pending.
 */
export type SnapshotBatchPushFn = (entries: SnapshotBatchEntry[]) => Promise<Map<string, boolean>>

/**
 * A note's snapshot bytes, captured and detached from the push that sends them.
 *
 * `pushSnapshotForNote` used to do both in one closure, which is what made
 * batching impossible: the send was inside the per-note bookkeeping. Producing
 * one of these performs every skip check and every "reset before push" step the
 * single-note path documents; `settle` performs the "restore on failure" and
 * "close a doc that was not already open" halves. Exactly one `settle` call per
 * prepared snapshot, whatever happened in between.
 */
interface PreparedSnapshot {
  noteId: string
  state: Uint8Array
  coverage: SnapshotCoverage
  settle: (pushed: boolean) => Promise<void>
}

export interface CrdtProviderOptions {
  inactiveDocLimit?: number
  now?: () => number
}

export interface CrdtDocSizeMetric {
  noteId: string
  encodedSizeBytes: number
  accumulatedBytes: number
  pendingSnapshotBytes: number
  windowCount: number
  lastTouchedAt: number
}

export interface CrdtOpenDocMetrics {
  count: number
  totalEncodedSizeBytes: number
  totalAccumulatedBytes: number
  docs: CrdtDocSizeMetric[]
}

interface ActiveDoc {
  doc: Y.Doc
  windowIds: Set<number>
  accumulatedBytes: number
  pendingSnapshotBytes: number
  lastEncodedSize: number
  lastSizeCheckAt: number
  lastTouchedAt: number
  /**
   * "This note never leaves the device", cached off the index row at doOpen.
   *
   * Cached rather than read per update because the only reader that matters is
   * `onDocUpdate`, which runs on every keystroke: a `getIndexDatabase()` lookup
   * there would put a synchronous SQLite round-trip on the typing path. Opening
   * a doc already pays an async store read plus (usually) a file stat, read and
   * markdown parse, so one more primary-key SELECT there is noise.
   *
   * Kept in step by `setNoteLocalOnly`, which the note runtime calls from the
   * same function that writes the flag to both databases. A doc that is closed
   * when the toggle happens needs nothing: its next doOpen re-reads the row.
   *
   * Every path that would send this doc's bytes to the server reads it: the
   * update-queue branch of `onDocUpdate`, and the three snapshot pushes in
   * `close`, `pushAllSnapshots` and `compactDoc`. `pushSnapshotForNote` is
   * reached for notes with no open doc at all and re-reads the row instead.
   */
  localOnly: boolean
  closing?: boolean
}

export class CrdtProvider {
  private docs = new Map<string, ActiveDoc>()
  private openLocks = new Map<string, Promise<Y.Doc>>()
  private persistence: CrdtPersistence | null = null
  /** See `storeId`. Minted on every successful open, dropped on `destroy()`. */
  private storeIdentity: string | null = null
  private persistenceReady = false
  private persistenceInitPromise: Promise<void> | null = null
  private updateQueue: NoteBodyOutbox | null = null
  private snapshotPushFn: SnapshotPushFn | null = null
  private snapshotBatchPushFn: SnapshotBatchPushFn | null = null
  private snapshotCoverage: SnapshotCoverageReader = NO_COVERAGE
  /** Answers whether the owe is durable (#2421). */
  private oweRemoteMerge:
    ((noteId: string, reason: 'local_only' | 'compaction') => boolean) | null = null
  /**
   * The data DB handle and vault the open store belongs to, bound at init
   * (#2421): a detached compaction owes its debt there, and never to a vault
   * opened since.
   */
  private boundVault: { db: DataDb; vaultUuid: string } | null = null
  /** Runs the owed-compactions marker's read-modify-writes one at a time. */
  private owedCompactions: Promise<void> = Promise.resolve()
  /**
   * Snapshot claims this session cannot vouch for (#2299, 07 §7.7.1): a claim
   * says the doc holds every body at or below LAST_CURSOR, which holds only for
   * a doc merged from this store. `storeUnreconciled` covers the whole store
   * (its epoch reconcile threw); `unvouchedNotes` holds notes whose doc was
   * created or seeded without persisted state (a new note or journal, a
   * markdown seed, a failed store read) or that the feed dropped as rowless,
   * until a whole-body pull of the note merges. In-memory mode vouches for
   * nothing. Session-only: the next open re-derives them.
   */
  private storeUnreconciled = false
  private unvouchedNotes = new Set<string>()
  /**
   * Notes already given a full-state row during the current queue-less stretch
   * — see `recordUnqueuedUpdate`. Purely a write-dedupe: the rows live in
   * sync_queue.
   */
  private recordedUnqueuedNotes = new Set<string>()
  private readonly inactiveDocLimit: number
  /** Bootstrap-only raise over `inactiveDocLimit`; see raiseInactiveDocCapacity. */
  private inactiveDocCapacityOverride: number | null = null
  private readonly now: () => number
  private compactingDocs = new Set<string>()
  private compactionBuffers = new Map<string, Uint8Array[]>()
  private networkBatcher = new MicrotaskBatchBroadcaster((noteId, merged) => {
    this.broadcastToWindows(noteId, merged, ORIGIN_NETWORK, undefined)
  })

  constructor(options: CrdtProviderOptions = {}) {
    this.inactiveDocLimit = Math.max(1, options.inactiveDocLimit ?? DEFAULT_INACTIVE_DOC_LIMIT)
    this.now = options.now ?? Date.now
  }

  /**
   * How many editor-less docs stay cached before the LRU starts closing them.
   *
   * A caller that holds several docs open across an await — sync's batch CRDT
   * pull is the one that does — must not open more than this in one pass, or
   * the docs it opened first are closed underneath it. See applyCrdtBatch.
   */
  get inactiveDocCapacity(): number {
    return this.inactiveDocCapacityOverride ?? this.inactiveDocLimit
  }

  /**
   * Temporarily hold more editor-less docs than the steady-state limit —
   * bootstrap bulk apply raises this so a cold CRDT batch is not forced into
   * limit-sized sub-chunks. Returns the restore function; calling it drops the
   * override and immediately evicts back down to the steady-state limit
   * through the normal close path, so every doc shed by the revert is flushed
   * to the store (and pushes its pending snapshot) exactly as an ordinary
   * eviction would.
   *
   * Never lowers the effective capacity: a second concurrent raise keeps the
   * larger of the two, and restore is idempotent. Callers must not hold more
   * docs open across an await than the capacity in force once they restore —
   * the same contract `inactiveDocCapacity` documents.
   */
  raiseInactiveDocCapacity(limit: number): () => Promise<void> {
    const requested = Math.max(this.inactiveDocLimit, Math.floor(limit))
    this.inactiveDocCapacityOverride = Math.max(requested, this.inactiveDocCapacityOverride ?? 0)
    let restored = false
    return async () => {
      if (restored) return
      restored = true
      this.inactiveDocCapacityOverride = null
      await this.evictInactiveDocsIfNeeded()
    }
  }

  /**
   * Wired by the sync runtime once its engine exists (#2299). Until then, and
   * after teardown, every push claims nothing and its fn routes it as before.
   */
  setSnapshotCoverage(reader: SnapshotCoverageReader | null): void {
    this.snapshotCoverage = reader ?? NO_COVERAGE
  }

  /**
   * Wired by the sync runtime: owe a note a whole-body pull, which flags it
   * until that pull merges. A note leaving local-only needs it (#2299): the
   * change feed skipped its bodies without flagging it.
   */
  setOweRemoteMerge(
    owe: ((noteId: string, reason: 'local_only' | 'compaction') => boolean) | null
  ): void {
    this.oweRemoteMerge = owe
    if (owe) void this.oweStoredCompactions(owe)
  }

  /**
   * Owe the compactions a detached provider could only record in its store
   * (#2421). The marker is cleared only once every owe was durable.
   */
  private oweStoredCompactions(
    owe: (noteId: string, reason: 'compaction') => boolean
  ): Promise<void> {
    return this.withOwedCompactions(async (persistence) => {
      const owed = await persistence.getMeta(OWED_COMPACTIONS_DOC, OWED_COMPACTIONS_KEY)
      if (!Array.isArray(owed) || owed.length === 0) return
      let durable = true
      for (const noteId of owed) {
        if (typeof noteId === 'string' && !owe(noteId, 'compaction')) durable = false
      }
      if (durable) await persistence.setMeta(OWED_COMPACTIONS_DOC, OWED_COMPACTIONS_KEY, [])
    }, 'Could not read the compactions owed while no sync runtime ran')
  }

  /** Chained after every earlier marker read-modify-write, so none loses another's ids. */
  private withOwedCompactions(
    fn: (persistence: CrdtPersistence) => Promise<void>,
    failure: string
  ): Promise<void> {
    const persistence = this.persistence
    if (!persistence) return Promise.resolve()
    const run = this.owedCompactions
      .then(() => fn(persistence))
      .catch((err) => log.error(failure, { error: err }))
    this.owedCompactions = run
    return run
  }

  private canVouchFor(noteId: string): boolean {
    return this.persistence !== null && !this.storeUnreconciled && !this.unvouchedNotes.has(noteId)
  }

  /** A whole-body pull of the note merged: its doc now holds the server state. */
  recordWholeBodyMerged(noteId: string): void {
    this.unvouchedNotes.delete(noteId)
  }

  /**
   * The feed dropped a body of this id because no row existed yet (#2299,
   * review B-L4): a note or journal created here later under the same id
   * lacks it, so it claims nothing until a whole-body pull merges.
   */
  withholdClaimUntilPulled(noteId: string): void {
    this.unvouchedNotes.add(noteId)
  }

  /** The first half of `encodeForPush`, awaited before the doc is encoded. */
  private async readPushBase(noteId: string): Promise<PushBase> {
    const watermark = await this.getSnapshotWatermark(noteId)
    return { noteId, revision: watermark?.snapshotRevision }
  }

  /**
   * The only way to produce snapshot push bytes (#2299): the claim is read in
   * the same synchronous step as the encode, after the base revision. A feed
   * page can land bodies and move LAST_CURSOR at any await, so a claim read
   * after the bytes could name rows they do not hold. A reader that throws
   * claims nothing and routes the push around the prune.
   */
  private encodeForPush(
    base: PushBase,
    encode: () => Uint8Array
  ): { state: Uint8Array; coverage: SnapshotCoverage } {
    let coverage: SnapshotCoverage
    try {
      coverage = this.snapshotCoverage(base.noteId, base.revision)
    } catch (err) {
      log.warn('Snapshot coverage could not be read; claiming nothing', {
        noteId: base.noteId,
        error: err
      })
      coverage = { unmerged: true }
    }
    if (coverage.coversThrough !== undefined && !this.canVouchFor(base.noteId)) {
      coverage = { unmerged: coverage.unmerged }
    }
    if (coverage.coversThrough !== undefined && base.revision !== undefined) {
      coverage = { ...coverage, baseRevision: base.revision }
    }
    return { state: encode(), coverage }
  }

  async init(
    queue?: NoteBodyOutbox,
    snapshotPush?: SnapshotPushFn,
    /**
     * Optional on purpose: every caller that does not wire one keeps the
     * per-note path exactly as it is, which is what the tests and the
     * no-session provider rely on.
     */
    snapshotBatchPush?: SnapshotBatchPushFn
  ): Promise<void> {
    await this.initPersistence()

    this.updateQueue = queue ?? null
    this.snapshotPushFn = snapshotPush ?? null
    this.snapshotBatchPushFn = snapshotBatchPush ?? null
    // Start the next queue-less stretch from a clean slate. Whatever was
    // recorded during the previous one is in sync_queue and is the outbox's
    // now; keeping the ids here would suppress the re-record if this provider
    // ever went queue-less again after the outbox pushed those rows.
    this.recordedUnqueuedNotes.clear()
    log.debug('CrdtProvider sync callbacks updated')
  }

  /**
   * Open this vault's CRDT store, if a vault is open.
   *
   * Safe — and expected — to call more than once: main calls it at bootstrap,
   * before any vault exists, and the vault open path calls it again once the
   * store can actually be scoped. A settled init is never redone; a *deferred*
   * one (no vault) is not settled and must be retried.
   */
  async initPersistence(): Promise<void> {
    // Never retry a settled init: a failed probe means the native binding is
    // broken for this process — re-probing would just re-pay the timeout.
    if (this.persistenceReady) {
      return
    }

    if (!this.persistenceInitPromise) {
      this.persistenceInitPromise = this.doInitPersistence().finally(() => {
        this.persistenceInitPromise = null
      })
    }
    return this.persistenceInitPromise
  }

  private async doInitPersistence(): Promise<void> {
    // Scoped to the open vault, not to the install. One store for every vault
    // was keyed by note id alone, and journal notes use deterministic
    // date-based ids (`j2026-08-13`), so two vaults' journals for the same day
    // shared a key — the collision sign-out used to "contain" by deleting the
    // whole store, and with it every note's merge history.
    const target = await prepareVaultCrdtStore()
    if (!target) {
      // No vault is open: main initializes the provider before
      // autoOpenLastVault(), and the vault picker has no vault at all. Leaving
      // persistenceReady false is the point — this is a deferral, not a settled
      // init, so openVault's call runs it again for real.
      log.info('CRDT store init deferred until a vault is open')
      return
    }

    // Preflight, quarantine and probe live in crdt-persistence.ts; null means
    // the store could not be trusted and this provider runs in-memory.
    this.persistence = await openCrdtPersistence(target.storagePath)
    this.boundVault = { db: getDatabase(), vaultUuid: target.vaultUuid }
    if (this.persistence) {
      // Before anything can push from this store (#2299): a store without the
      // marker withholds snapshot claims until the vault is swept again.
      try {
        await reconcileCrdtStoreEpoch(this.persistence, getDatabase())
      } catch (err) {
        this.storeUnreconciled = true
        log.warn('Could not reconcile the CRDT store epoch; claims withheld until the next open', {
          error: err
        })
      }
    }
    // Minted per successful open, never derived from the path: two opens of the
    // same directory are still two store lifetimes, and anything holding state
    // that describes the first one must not carry it into the second. A store
    // that could not be opened leaves this null, which is what makes in-memory
    // mode read as "no store" rather than as "an empty one".
    this.storeIdentity = this.persistence ? crypto.randomUUID() : null
    this.persistenceReady = true
    recordSessionPersistenceOutcome(this.persistence !== null)

    // The readiness signal a stranded editor waits on, announced from the exact
    // assignment that makes crdt:open-doc stop rejecting — the IPC handler gates
    // on isInitialized(), which is this flag. Announcing anywhere earlier would
    // be optimistic: the store's preflight/probe is what the await above pays
    // for, and a window that re-opened before it settled would be rejected all
    // over again. Whatever else main attaches to a fresh provider (init()'s
    // body outbox and snapshot push) lands in the same microtask as this
    // resolve, so a renderer's IPC round-trip can never beat it.
    broadcastToAllWindows(CRDT_EVENTS.PROVIDER_READY)
    log.info('CRDT provider ready, asked stranded editors to rebind')
  }

  isInitialized(): boolean {
    return this.persistenceReady
  }

  /**
   * Whether this provider is backed by the on-disk store. False means CRDT
   * state lives only in this process: notes are still read from and written
   * back to vault markdown, but edit history and the local state vector are
   * gone at quit. Only meaningful once `isInitialized()` is true.
   */
  hasPersistence(): boolean {
    return this.persistence !== null
  }

  /**
   * Opaque identity of the store this provider currently holds open, or `null`
   * when it holds none — no vault yet, in-memory mode, or after `destroy()`.
   *
   * It exists so that anything caching state *derived from* the store can tell
   * that the store underneath it changed. The durable snapshot watermarks live
   * inside the store and so cannot outlive it, but the sweep also keeps them in
   * memory for the length of a pass, and that copy has no such guarantee: a
   * vault switch, a quarantine-and-reopen or a re-path replaces the store while
   * the process keeps running. Comparing this value is how that copy gets
   * dropped in the same operation. A fresh id after a benign reopen costs
   * nothing — the watermarks are re-read from the store that just opened.
   */
  get storeId(): string | null {
    return this.persistence ? this.storeIdentity : null
  }

  /**
   * This note's persisted snapshot watermark, or `null` when there is none to
   * act on.
   *
   * Read through the store handle and nowhere else, which is the point: no
   * store, no watermark. `null` means *unknown*, and every caller must answer an
   * unknown with a fetch — a store written by a build that predates this key
   * lands here, and so does a read that failed.
   */
  async getSnapshotWatermark(noteId: string): Promise<CrdtSnapshotWatermark | null> {
    const persistence = this.persistence
    if (!persistence) return null
    try {
      return await readSnapshotWatermark(persistence, noteId)
    } catch (err) {
      // A watermark that cannot be read is a watermark that does not exist, and
      // that answer only ever costs one extra snapshot GET.
      log.warn('Could not read the persisted CRDT snapshot watermark', { noteId, error: err })
      return null
    }
  }

  /**
   * Record this note's snapshot watermark in the store.
   *
   * Called after the bytes it describes are already on their way into the same
   * LevelDB: `applyRemoteUpdate` hands the update to `storeUpdate` before this
   * runs, and y-leveldb serialises its transactions, so the document write is
   * queued ahead of the meta write. A crash between them loses the watermark and
   * keeps the document, which is the direction this whole feature must fail in.
   */
  async putSnapshotWatermark(noteId: string, watermark: CrdtSnapshotWatermark): Promise<void> {
    const persistence = this.persistence
    if (!persistence) return
    try {
      await writeSnapshotWatermark(persistence, noteId, watermark)
    } catch (err) {
      log.warn('Could not persist the CRDT snapshot watermark', { noteId, error: err })
    }
  }

  /**
   * Drop this note's watermark from the store: a record that does not decode
   * reads back as unknown, and unknown fetches. For a watermark shown to be
   * ahead of the doc (#2297 review B-H2).
   */
  async forgetSnapshotWatermark(noteId: string): Promise<void> {
    const persistence = this.persistence
    if (!persistence) return
    try {
      await persistence.setMeta(noteId, SNAPSHOT_WATERMARK_META_KEY, null)
    } catch (err) {
      log.warn('Could not drop the CRDT snapshot watermark', { noteId, error: err })
    }
  }

  /**
   * Wait for a store init that is ALREADY in flight, and do nothing when there
   * is none.
   *
   * The difference from `initPersistence()` matters: this never starts one. An
   * editor is no longer gated on a sync session, so `crdt:open-doc` can arrive
   * before the vault-open path's (deliberately un-awaited) init has settled,
   * and it needs to wait rather than reject — but it must not be the caller
   * that decides *which* vault the store belongs to. `closeVault` resets the
   * provider before it closes the databases, so a self-starting init in that
   * window would resolve the outgoing vault's uuid and the incoming vault would
   * then inherit a settled store pointing at its predecessor's history.
   *
   * A failed init resolves here rather than rejecting: the caller's next
   * question is `isInitialized()`, which is the honest answer either way.
   */
  async awaitPendingInit(): Promise<void> {
    await this.persistenceInitPromise?.catch(() => {})
  }

  async open(noteId: string, windowId?: number, options?: { skipSeed?: boolean }): Promise<Y.Doc> {
    const existing = this.docs.get(noteId)
    if (existing && !existing.closing) {
      if (windowId) existing.windowIds.add(windowId)
      this.touchDoc(existing)
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, existing.doc)
      }
      await this.evictInactiveDocsIfNeeded()
      return existing.doc
    }

    const pending = this.openLocks.get(noteId)
    if (pending) {
      const doc = await pending
      const entry = this.docs.get(noteId)
      if (entry) {
        if (windowId) entry.windowIds.add(windowId)
        this.touchDoc(entry)
      }
      if (!options?.skipSeed) {
        await this.seedFromMarkdown(noteId, doc)
      }
      await this.evictInactiveDocsIfNeeded()
      return doc
    }

    const promise = this.doOpen(noteId, windowId, options)
    this.openLocks.set(noteId, promise)
    try {
      return await promise
    } finally {
      this.openLocks.delete(noteId)
    }
  }

  private async doOpen(
    noteId: string,
    windowId?: number,
    options?: { skipSeed?: boolean }
  ): Promise<Y.Doc> {
    const doc = new Y.Doc({ guid: noteId })
    this.initDocStructure(doc)

    // y-leveldb answers an empty doc for a note it never stored.
    let loaded = false
    if (this.persistence) {
      try {
        const persisted = await this.persistence.getYDoc(noteId)
        if (persisted) {
          loaded = Y.encodeStateVector(persisted).length > 1
          const update = Y.encodeStateAsUpdate(persisted)
          Y.applyUpdate(doc, update)
          persisted.destroy()
          // Heal notes previously persisted with empty block ids, which crash the
          // editor with "Block doesn't have id" on mount.
          let repaired = 0
          doc.transact(() => {
            repaired = repairEmptyBlockIds(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
          }, ORIGIN_LOCAL)
          if (repaired > 0) {
            log.info('Repaired empty block ids in persisted note', { noteId, count: repaired })
            await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc))
          }
        } else {
          log.warn('CRDT persistence returned empty doc; continuing in-memory', { noteId })
        }
      } catch (err) {
        // A failing store must not block the note from opening — fall through
        // to the markdown seed below so content stays visible.
        log.error('Failed to load persisted CRDT doc; seeding from vault file', {
          noteId,
          error: err
        })
      }
    }

    if (!loaded) this.unvouchedNotes.add(noteId)
    if (!options?.skipSeed) {
      await this.seedFromMarkdown(noteId, doc)
    }

    const entry: ActiveDoc = {
      doc,
      windowIds: new Set(windowId ? [windowId] : []),
      accumulatedBytes: 0,
      pendingSnapshotBytes: 0,
      lastEncodedSize: 0,
      lastSizeCheckAt: 0,
      lastTouchedAt: this.now(),
      localOnly: this.isNoteLocalOnly(noteId)
    }
    this.docs.set(noteId, entry)

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(noteId, update, origin)
    })

    await this.evictInactiveDocsIfNeeded()

    return doc
  }

  /**
   * Read the note's "never leaves this device" flag off the index row.
   *
   * Falls back to "not local-only" when the row cannot be read at all — an
   * index database that is closed or missing, which `doOpen` can hit on the
   * `skipSeed` path that otherwise never touches it. That is the behaviour this
   * provider has always had, so an unreadable row costs sync nothing; the
   * authoritative check for the payload that actually carries a body — the
   * snapshot — re-reads the row live in `pushSnapshotForNote`.
   *
   * Public because the flag is not only a push-side concern: `CrdtSyncCoordinator`
   * asks the same question before it pulls, and the note-body outbox asks it
   * before it pushes a full-state row at all. Both want the live row rather
   * than a doc's cached copy — neither is guaranteed to have the doc open.
   */
  isNoteLocalOnly(noteId: string): boolean {
    try {
      return getNoteCacheById(getIndexDatabase(), noteId)?.localOnly === true
    } catch (err) {
      log.warn('Could not read the local-only flag for a note; treating it as syncable', {
        noteId,
        error: err
      })
      return false
    }
  }

  /**
   * Point the open doc's cached flag at the value both databases now hold.
   *
   * Called by `setNoteLocalOnlyState` — the single place the toggle is written
   * — immediately after the two writes, so a doc opened concurrently and this
   * doc agree. A note with no open doc needs nothing: `doOpen` re-reads.
   *
   * Either direction also hands the doc's snapshot debt to the note-body
   * outbox, by clearing it here. Clearing it going ON is obvious. Going OFF
   * matters more: nothing else pushes the body written while the note was
   * local-only, so this queues a full-state row, which the outbox pushes after
   * merging the server's state. A note that has just stopped being local-only
   * is precisely the population most likely to have diverged from a peer, and
   * leaving the debt would let the next `close()` fire a *blind* snapshot first
   * — a snapshot asserts completeness, so the server prunes the peer edits it
   * does not contain.
   *
   * Going ON also drops the note's queued body rows, and that is not the same
   * window as the flag above. `onDocUpdate` reads the flag at *enqueue* time,
   * but the outbox flushes on a ~1s window, so every update typed in the second
   * before the toggle is already queued and would still be pushed. The drop
   * happens ahead of the `docs` lookup: a doc the LRU has since evicted still
   * leaves rows behind.
   */
  setNoteLocalOnly(noteId: string, localOnly: boolean): void {
    if (localOnly) {
      this.dropOwedBody(noteId)
    } else {
      this.recordOwedFullState(noteId)
      this.oweRemoteMerge?.(noteId, 'local_only')
    }

    const entry = this.docs.get(noteId)
    if (!entry) return
    entry.localOnly = localOnly
    entry.pendingSnapshotBytes = 0
  }

  async close(noteId: string, windowId?: number): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry || entry.closing) return

    if (windowId) {
      entry.windowIds.delete(windowId)
      if (entry.windowIds.size > 0) return
    }

    entry.closing = true

    this.flushNetworkBroadcast(noteId)

    const push = this.snapshotPushFn
    if (push && entry.pendingSnapshotBytes > 0 && !entry.localOnly) {
      const pushed = this.readPushBase(noteId).then((base) => {
        const { state, coverage } = this.encodeForPush(base, () => Y.encodeStateAsUpdate(entry.doc))
        return push(noteId, state, coverage)
      })
      await pushed.catch((err) => {
        log.warn('Failed to push snapshot on close', { noteId, error: err })
      })
      entry.pendingSnapshotBytes = 0
    }

    await this.flushDoc(noteId).catch((err) => {
      log.error('Failed to flush doc on close', { noteId, error: err })
    })

    if (this.docs.get(noteId) !== entry) {
      // The note was reopened while the flush above was in flight, so doOpen()
      // put a *different* entry — with its own Y.Doc — in the map. That
      // replacement is what the editor is typing into, so the map entry must
      // stay exactly as it is. Only the superseded doc is retired here, and it
      // is provably unreachable: every routing path (applyIpcUpdate,
      // applyIpcSyncStep2, applyRemoteUpdate, getDoc, getDiff, getStateVector,
      // updateMeta, onDocUpdate, broadcastToWindows) re-reads this.docs by
      // noteId and therefore resolves the replacement; nothing outside the
      // provider retains a Y.Doc across awaits; and entry.doc is assigned only
      // in doOpen and in compactDoc's in-place swap, so one doc belongs to
      // exactly one entry and can never be shared with the replacement.
      // Destroying it detaches its 'update' listener instead of leaving it for
      // GC to notice.
      log.debug('Doc reopened during async close, destroying the superseded doc', { noteId })
      entry.doc.destroy()
      return
    }

    entry.doc.destroy()
    this.docs.delete(noteId)
    log.debug('Doc closed', { noteId })
  }

  /**
   * Close a doc this code opened for itself, unless a window has bound to it
   * since. Paths that open a doc only to read or push it must close through
   * here, never `close(noteId)`: an editor that opened the note in between
   * would lose its doc, and every edit after it (#2448).
   */
  async closeIfInactive(noteId: string): Promise<boolean> {
    const entry = this.docs.get(noteId)
    if (!entry || entry.closing || entry.windowIds.size > 0) return false

    await this.close(noteId)
    return !this.docs.has(noteId)
  }

  /**
   * Release every doc reference held by a window that no longer exists.
   *
   * The CLOSE_DOC invoke, sent from the renderer's React cleanup, is the only
   * other path that clears a windowId — and ⌘W, a reload, or a renderer crash
   * tears the process down without running it. BrowserWindow ids are monotonic
   * and never recycled, so the stale id pins the doc for the rest of the
   * session: close() early-returns, eviction skips it (windowIds.size === 0)
   * and compaction bails, leaving the update log to grow unbounded.
   *
   * Call this ONLY for a window that has actually been destroyed. A hidden,
   * minimised or background window is still live and must keep its docs
   * pinned. Docs another live window still holds are left untouched, and the
   * release goes through the same closeIfInactive path the sync engine uses,
   * so the doc is flushed to persistence before it is destroyed.
   */
  async forgetWindow(windowId: number): Promise<void> {
    const orphaned: string[] = []
    for (const [noteId, entry] of this.docs) {
      if (!entry.windowIds.delete(windowId)) continue
      if (entry.windowIds.size === 0) orphaned.push(noteId)
    }

    for (const noteId of orphaned) {
      await this.closeIfInactive(noteId)
    }

    if (orphaned.length > 0) {
      log.debug('Released docs held by a closed window', { windowId, count: orphaned.length })
    }
  }

  /**
   * Erase every trace of one note's CRDT state: the caller's guarantee that
   * nothing downstream can rebuild the note out of its doc.
   *
   * Each line ahead of `close()` closes a route that survives the doc itself.
   * The armed write-back keeps its own reference to the Y.Doc and, with the
   * note's index row already gone, would re-create the file from `meta.title`.
   * The note's queued body rows are not reachable from the doc at all. And the
   * snapshot debt would make `close()` push the body of a note that no longer
   * exists — a snapshot asserts completeness, so that push is what puts the
   * deleted note back on the server.
   *
   * Safe to repeat: every step converges on the same absence.
   */
  async purge(noteId: string): Promise<void> {
    cancelWriteback(noteId)
    this.dropOwedBody(noteId)

    const entry = this.docs.get(noteId)
    if (entry) entry.pendingSnapshotBytes = 0

    await this.close(noteId)
    await this.persistence?.clearDocument(noteId).catch((err) => {
      log.warn('Failed to clear persisted CRDT doc during purge', { noteId, error: err })
    })
  }

  getDoc(noteId: string): Y.Doc | undefined {
    return this.docs.get(noteId)?.doc
  }

  /**
   * `false` when the update was dropped (no open doc, or one closing): the
   * caller must not record it as merged (#2297 round 2 b-M3). An update
   * buffered by a compaction is merged when the compaction ends, so `true`.
   */
  applyRemoteUpdate(noteId: string, update: Uint8Array): boolean {
    const entry = this.docs.get(noteId)
    if (!entry) {
      log.warn('Received remote update for unopened doc', { noteId })
      return false
    }

    if (entry.closing) {
      log.debug('Ignoring remote update for closing doc', { noteId })
      return false
    }

    this.touchDoc(entry)

    log.debug('applyRemoteUpdate', {
      noteId,
      bytes: update.byteLength,
      windows: entry.windowIds.size
    })

    if (this.compactingDocs.has(noteId)) {
      const buf = this.compactionBuffers.get(noteId)
      if (buf) {
        buf.push(update)
        log.debug('Buffered remote update during compaction', {
          noteId,
          updateBytes: update.byteLength
        })
        return true
      }
    }

    Y.applyUpdate(entry.doc, update, ORIGIN_NETWORK)
    return true
  }

  /**
   * Merge a remote update into the note's open doc, like `applyRemoteUpdate`,
   * then store it explicitly and resolve on that write (#2297). The doc's own
   * `onDocUpdate` write is fire-and-forget and swallows its error, so it cannot
   * tell the change-feed landing whether the bytes reached the store; the
   * duplicate append is cheap, and y-leveldb merges it on the next flush. An
   * update that changed nothing (this device's own echo) is not stored again:
   * Yjs emits `update` only for a change, deletions included.
   *
   * Rejects with no store, and with no open doc: bytes stored without a live
   * merge make every later merge of the same state a no-op, so the write-back
   * that writes the vault file would never run.
   *
   * Resolves `false` while the doc is compacting (#2299, review B-M4): the
   * update is only buffered, in neither the doc nor the store, and a failed or
   * abandoned compaction can drop it, so the caller must owe the note.
   */
  async mergeRemoteUpdate(noteId: string, update: Uint8Array): Promise<boolean> {
    if (!this.persistence) throw new Error('No CRDT store to hold a change-feed body')
    const entry = this.docs.get(noteId)
    if (!entry || entry.closing) throw new Error('No open doc to merge a change-feed body into')
    if (this.compactingDocs.has(noteId)) {
      this.applyRemoteUpdate(noteId, update)
      return false
    }
    let changed = false
    const onUpdate = (): void => {
      changed = true
    }
    entry.doc.on('update', onUpdate)
    try {
      this.applyRemoteUpdate(noteId, update)
    } finally {
      entry.doc.off('update', onUpdate)
    }
    if (changed) await this.persistence.storeUpdate(noteId, update)
    return true
  }

  /**
   * Record the snapshot this device just pushed as merged into its doc (#2297):
   * the pushed state came from the doc, so it holds that blob and everything
   * the push asserted up to `sequenceNum`. The change feed then skips this
   * device's own snapshot instead of downloading it back. Ordered after the
   * doc's own writes on the store, like `putSnapshotWatermark`.
   */
  async recordPushedSnapshot(
    noteId: string,
    pushed: { sequenceNum?: number; revision?: string }
  ): Promise<void> {
    if (!pushed.revision || typeof pushed.sequenceNum !== 'number') return
    const held = await this.getSnapshotWatermark(noteId)
    await this.putSnapshotWatermark(noteId, {
      appliedSequence: Math.max(held?.appliedSequence ?? 0, pushed.sequenceNum),
      snapshotRevision: pushed.revision
    })
  }

  getStateVector(noteId: string): Uint8Array | null {
    const entry = this.docs.get(noteId)
    if (!entry) return null
    this.touchDoc(entry)
    return Y.encodeStateVector(entry.doc)
  }

  getDiff(noteId: string, remoteStateVector: Uint8Array): Uint8Array | null {
    const entry = this.docs.get(noteId)
    if (!entry) return null
    this.touchDoc(entry)
    return Y.encodeStateAsUpdate(entry.doc, remoteStateVector)
  }

  /**
   * Open docs an editor window is currently attached to — measured live, or as
   * of `destroy()` once the map has been emptied.
   *
   * Every one of these is an editor whose renderer-side provider is bound to a
   * doc this instance owns. When the instance is dropped, that binding is dead
   * and the editor cannot know: main goes on applying remote updates, to the
   * new instance's docs, and broadcasts them to a window set the editor is no
   * longer in. So this is the number a provider reset has to bring back — see
   * `resetCrdtProvider`.
   */
  get strandedEditorDocCount(): number {
    if (this.docs.size === 0) return this.attachedDocsAtDestroy
    let count = 0
    for (const entry of this.docs.values()) {
      if (entry.windowIds.size > 0) count++
    }
    return count
  }

  private attachedDocsAtDestroy = 0

  async destroy(): Promise<void> {
    // Read before the map is cleared below: after that the count is gone, and
    // the reset that follows destroy() is where it has to be reported.
    this.attachedDocsAtDestroy = this.strandedEditorDocCount
    await flushPendingWritebacks()
    this.networkBatcher.flushAll()

    for (const [noteId] of this.docs) {
      try {
        await this.flushDoc(noteId)
      } catch (err) {
        log.warn('Failed to flush doc during CRDT destroy', { noteId, error: err })
      }
    }
    for (const [, entry] of this.docs) {
      entry.doc.destroy()
    }
    this.docs.clear()

    if (this.persistence) {
      try {
        await this.persistence.destroy()
      } catch (err) {
        log.warn('Failed to close CRDT persistence on destroy', { error: err })
      }
      this.persistence = null
    }
    // Dropped with the store, in the same operation. Anything still holding
    // watermarks read out of that store now sees a different `storeId` and has
    // to throw its copy away — see the getter.
    this.storeIdentity = null
    this.boundVault = null
    this.persistenceReady = false

    this.openLocks.clear()
    this.updateQueue = null
    this.snapshotPushFn = null
    this.snapshotBatchPushFn = null
    this.snapshotCoverage = NO_COVERAGE
    this.oweRemoteMerge = null
    this.storeUnreconciled = false
    this.unvouchedNotes.clear()

    // Write-back keeps its own module-level per-note maps, keyed by ids and
    // absolute paths belonging to the vault being torn down here.
    resetWritebackState()

    log.info('CrdtProvider destroyed')
  }

  /**
   * Every doc the provider holds, which is not the same as every doc an editor
   * has open: the LRU keeps up to inactiveDocLimit docs cached after their
   * editors closed. Pass `{ active: true }` for the strict subset that still has
   * a window attached — what a caller wants when it must bound per-doc work to
   * what the user is actually looking at.
   */
  getOpenNoteIds({ active = false } = {}): string[] {
    return [...this.docs].filter(([, doc]) => !active || doc.windowIds.size > 0).map(([id]) => id)
  }

  getDocSizeMetrics(): CrdtDocSizeMetric[] {
    return Array.from(this.docs.entries()).map(([noteId, entry]) =>
      this.measureDocSize(noteId, entry)
    )
  }

  getOpenDocMetrics(): CrdtOpenDocMetrics {
    const docs = this.getDocSizeMetrics()
    return {
      count: docs.length,
      totalEncodedSizeBytes: docs.reduce((total, doc) => total + doc.encodedSizeBytes, 0),
      totalAccumulatedBytes: docs.reduce((total, doc) => total + doc.accumulatedBytes, 0),
      docs
    }
  }

  async pushAllSnapshots(): Promise<number> {
    if (!this.snapshotPushFn) {
      log.debug('No snapshotPushFn configured, skipping server push')
      return 0
    }

    let pushed = 0
    for (const [noteId, entry] of this.docs) {
      if (entry.localOnly) continue
      if (entry.pendingSnapshotBytes <= 0) continue
      try {
        const base = await this.readPushBase(noteId)
        const { state, coverage } = this.encodeForPush(base, () => Y.encodeStateAsUpdate(entry.doc))
        await this.snapshotPushFn(noteId, state, coverage)
        entry.accumulatedBytes = 0
        entry.pendingSnapshotBytes = 0
        pushed++
        log.info('Pushed server snapshot', { noteId, size: state.byteLength })
      } catch (err) {
        log.warn('Failed to push server snapshot', { noteId, error: err })
      }
    }
    return pushed
  }

  /**
   * Everything `pushSnapshotForNote` does EXCEPT the send.
   *
   * `null` means "nothing to push" — and it means it for all three of the
   * reasons the single-note path refuses: a binary note, a local-only note, and
   * an empty document. It is also what an open that threw returns, in which
   * case the counters are already back where they were.
   *
   * A prepared snapshot has already had its counters zeroed, so a `close()`
   * racing the send — the LRU's eviction, an editor closing the tab — will not
   * fire a second push for the same bytes. `settle` is what puts them back if
   * the send did not land, and it is the caller's obligation.
   */
  private async prepareSnapshotForNote(noteId: string): Promise<PreparedSnapshot | null> {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (cached?.fileType && isBinaryFileType(cached.fileType)) {
      log.debug('Skipping CRDT snapshot push for binary note', {
        noteId,
        fileType: cached.fileType
      })
      return null
    }

    // The row is already in hand, so the authoritative read costs nothing here
    // — and this is the one push path that is reached for a note with no open
    // doc (the push coordinator's create, the oversized-update fallback), so it
    // cannot lean on the per-doc cached flag.
    //
    // `false` is honest to both callers: the replay reads it as "not settled"
    // and keeps the id, which is what a note that may be un-toggled later wants
    // — a `true` here would be the provider claiming a push it refused to make.
    if (cached?.localOnly) {
      log.debug('Skipping CRDT snapshot push for a local-only note', { noteId })
      return null
    }

    const wasOpen = this.docs.has(noteId)
    let clearedAccumulated = 0
    let clearedPending = 0
    try {
      const doc = await this.open(noteId)
      const entry = this.docs.get(noteId)
      const base = await this.readPushBase(noteId)
      const { state, coverage } = this.encodeForPush(base, () => Y.encodeStateAsUpdate(doc))
      if (state.length <= 4) {
        if (!wasOpen) await this.closeIfInactive(noteId)
        return null
      }

      // Reset accumulatedBytes BEFORE push so close() won't fire a duplicate push
      if (entry) {
        clearedAccumulated = entry.accumulatedBytes
        clearedPending = entry.pendingSnapshotBytes
        entry.accumulatedBytes = 0
        entry.pendingSnapshotBytes = 0
      }

      return {
        noteId,
        state,
        coverage,
        settle: async (pushed: boolean): Promise<void> => {
          if (!pushed) {
            // Restore the pre-push counters (additive: updates may have landed
            // mid-push) so pushAllSnapshots and close() still retry this note.
            // Re-read rather than closing over `entry`: a batch holds its
            // prepared notes across one network round trip, long enough for the
            // LRU to evict a doc or for doOpen to have put a replacement in the
            // map, and the debt belongs to whatever entry is live now.
            const live = this.docs.get(noteId)
            if (live) {
              live.accumulatedBytes += clearedAccumulated
              live.pendingSnapshotBytes += clearedPending
            }
          }
          if (!wasOpen) await this.closeIfInactive(noteId)
        }
      }
    } catch (err) {
      log.warn('Preparing a CRDT snapshot failed', { noteId, error: err })
      const live = this.docs.get(noteId)
      if (live) {
        live.accumulatedBytes += clearedAccumulated
        live.pendingSnapshotBytes += clearedPending
      }
      if (!wasOpen) await this.closeIfInactive(noteId)
      return null
    }
  }

  /**
   * The note's whole doc state for a full-state outbox row, or `null` when the
   * note no longer syncs (deleted, binary, local-only) or is empty. A doc that
   * was not open is closed again afterwards.
   */
  async readSyncableState(noteId: string): Promise<Uint8Array | null> {
    if (!this.isNoteSyncable(noteId)) return null
    const wasOpen = this.docs.has(noteId)
    try {
      const state = Y.encodeStateAsUpdate(await this.open(noteId))
      return state.length <= 4 ? null : state
    } finally {
      if (!wasOpen) await this.closeIfInactive(noteId)
    }
  }

  async pushSnapshotForNote(noteId: string): Promise<boolean> {
    const push = this.snapshotPushFn
    if (!push) return false

    const prepared = await this.prepareSnapshotForNote(noteId)
    if (!prepared) return false

    try {
      await push(noteId, prepared.state, prepared.coverage)
      log.info('Pushed snapshot for note', { noteId, size: prepared.state.byteLength })
      await prepared.settle(true)
      return true
    } catch (err) {
      log.warn('pushSnapshotForNote failed', { noteId, error: err })
      await prepared.settle(false)
      return false
    }
  }

  /**
   * Push several notes' snapshots, in as few requests as the server allows.
   *
   * The whole point of the method: one seeded vault used to cost one
   * `POST /sync/crdt/snapshot` per note (~750ms each, ~600ms of it server-side),
   * so 100 bodies took 15 seconds. Every note is still prepared and settled
   * individually — the skips, the counter reset, the restore-on-failure and the
   * `close()` of a doc nothing else had open are per note and unchanged — only
   * the send is shared.
   *
   * Returns one entry per DISTINCT id, so a caller can tell which notes reached
   * the server. Duplicate ids are collapsed rather than prepared twice: the
   * batch endpoint rejects a request that repeats a noteId, and preparing the
   * same note twice would zero its counters, hand the second prepare nothing to
   * restore, and lose the debt.
   *
   * With no batch fn wired this is exactly the old behaviour — N single pushes
   * at the same concurrency — which is what keeps every non-runtime caller and
   * the sign-out path working unchanged.
   */
  async pushSnapshotsForNotes(
    noteIds: string[],
    options: { concurrency?: number; signal?: AbortSignal } = {}
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    const unique = [...new Set(noteIds)]
    if (unique.length === 0) return results

    const concurrency = Math.max(1, options.concurrency ?? 1)
    const batchPush = this.snapshotBatchPushFn

    if (!batchPush) {
      const tasks = unique.map((noteId) => async () => {
        results.set(noteId, await this.pushSnapshotForNote(noteId))
      })
      await parallelWithLimit(tasks, concurrency, options.signal)
      // A task that threw left no entry; the caller reads a missing id the same
      // way it reads `false`, but spelling it out keeps the "one entry per id"
      // contract literally true.
      for (const noteId of unique) if (!results.has(noteId)) results.set(noteId, false)
      return results
    }

    const chunks: string[][] = []
    for (let i = 0; i < unique.length; i += MAX_CRDT_SNAPSHOT_BATCH_ENTRIES) {
      chunks.push(unique.slice(i, i + MAX_CRDT_SNAPSHOT_BATCH_ENTRIES))
    }

    const tasks = chunks.map((chunk) => async () => {
      await this.pushSnapshotChunk(chunk, batchPush, results)
    })
    await parallelWithLimit(tasks, concurrency, options.signal)

    for (const noteId of unique) if (!results.has(noteId)) results.set(noteId, false)
    return results
  }

  private async pushSnapshotChunk(
    noteIds: string[],
    batchPush: SnapshotBatchPushFn,
    results: Map<string, boolean>
  ): Promise<void> {
    const prepared: PreparedSnapshot[] = []
    for (const noteId of noteIds) {
      const entry = await this.prepareSnapshotForNote(noteId)
      if (!entry) {
        results.set(noteId, false)
        continue
      }
      prepared.push(entry)
    }
    if (prepared.length === 0) return

    let outcome: Map<string, boolean>
    try {
      outcome = await batchPush(
        prepared.map(({ noteId, state, coverage }) => ({ noteId, state, coverage }))
      )
    } catch (err) {
      // SnapshotBatchPushFn is documented as total, so this is a bug rather
      // than a transport failure — treat it as one anyway: a thrown batch means
      // nothing landed, and every note has to stay retryable.
      log.warn('Batched CRDT snapshot push threw', { count: prepared.length, error: err })
      outcome = new Map()
    }

    let pushedCount = 0
    for (const entry of prepared) {
      const pushed = outcome.get(entry.noteId) === true
      if (pushed) pushedCount++
      results.set(entry.noteId, pushed)
      await entry.settle(pushed)
    }

    log.info('Pushed snapshots in a batch', {
      requested: prepared.length,
      pushed: pushedCount
    })
  }

  private initDocStructure(doc: Y.Doc): void {
    doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    doc.getMap('meta')
    doc.getArray('tags')
    doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
    // Typed here, before any persisted update is applied, so these roots are
    // never left as bare `AbstractType` placeholders. compactYDoc refuses to
    // compact a doc holding one, and write-back (the only other thing that
    // types them) is debounced 500 ms — an editor-less doc would otherwise
    // never compact.
    doc.getMap(MARKDOWN_SOURCE_MAP)
    doc.getArray(LINK_REFERENCE_DEFINITIONS_ARRAY)
    doc.getArray(LINK_REFERENCE_USAGES_ARRAY)
  }

  private async seedFromMarkdown(noteId: string, doc: Y.Doc): Promise<void> {
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    if (fragment.length > 0) return

    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return
    if (cached.fileType && isBinaryFileType(cached.fileType)) return

    const absolutePath = toAbsolutePath(cached.path)

    // Classify from `stat` before reading. The byte ceiling settles a large
    // file on its own, and the vault-wide sweep reaches every note on every
    // pass — reading 17 MB into the main process each time only to refuse it
    // is the read this guard exists to avoid. Same order as `getNoteById`.
    const stats = await fsp.stat(absolutePath).catch(() => null)
    const bySize = stats ? classifyMarkdownStat(stats.size) : null
    if (bySize) {
      log.warn('Refusing to seed a large-file-class note into CRDT', {
        noteId,
        reason: bySize.reason,
        fileBytes: bySize.fileBytes
      })
      return
    }

    const raw = await safeRead(absolutePath)
    if (!raw) {
      // An empty file seeds nothing, but its zero bytes WERE read and the empty
      // doc represents them faithfully. Recording the hash is what lets the
      // first keystroke into an empty foreign note reach the file — without it
      // the write-back's never-read guard would refuse that save forever,
      // since nothing else fills the column in (#1909).
      if (raw === '') this.recordSeedContentHash(indexDb, noteId, cached.contentHash, raw)
      return
    }

    // Before gray-matter, before BlockNote. The parse is what freezes the main
    // process — cost tracks single-block size, not file size — so a large-file
    // class note never gets a Y.Doc body. Under the byte ceiling the file is
    // cheap to read, and the block bound still has to be measured: a
    // sub-ceiling log dump is one enormous block and parses quadratically.
    const classification = classifyMarkdownContent(raw)
    if (classification.sizeClass === 'large-file') {
      log.warn('Refusing to seed a large-file-class note into CRDT', {
        noteId,
        reason: classification.reason,
        fileBytes: classification.fileBytes,
        largestBlockBytes: classification.largestBlockBytes
      })
      return
    }

    const parsed = parseNote(raw, cached.path)
    if (!parsed.content?.trim()) {
      // Frontmatter-only or whitespace-only: nothing to seed, but the bytes
      // WERE read and the empty doc represents the empty body faithfully, so
      // the same recording applies as for an empty file above.
      this.recordSeedContentHash(indexDb, noteId, cached.contentHash, raw)
      return
    }

    // Pass the note's path so embed targets are written relative to it — this
    // fragment is what gets serialized back to the vault file.
    const ok = await markdownToYFragment(parsed.content, fragment, cached.path)

    // Record what this doc was built from, so the write-back's external-edit
    // guard has something to compare against (#1909).
    //
    // A row listed from `stat` alone carries no `contentHash`, and until now
    // the guard treated "no hash" as "nothing to check" and wrote anyway —
    // straight over a file nobody had read. Refusing outright would be worse
    // for the user who opens such a note and edits it, because nothing else
    // ever fills that column in: `indexVault` skips a path that already has a
    // row. The bytes ARE read here, and the doc is built from them, so this is
    // the honest place to say so.
    if (ok) {
      this.recordSeedContentHash(indexDb, noteId, cached.contentHash, raw)
    }

    if (ok && this.persistence) {
      await this.persistence.storeUpdate(noteId, Y.encodeStateAsUpdate(doc)).catch((err) => {
        log.error('Failed to persist markdown-seeded CRDT doc', { noteId, error: err })
      })
    }
  }

  // A hash the indexer already measured is left alone; this only ever fills a
  // hole, and only with the hash of bytes the seed genuinely read.
  private recordSeedContentHash(
    indexDb: ReturnType<typeof getIndexDatabase>,
    noteId: string,
    existingHash: string | null | undefined,
    raw: string
  ): void {
    if (existingHash) return
    try {
      updateNoteCache(indexDb, noteId, { contentHash: generateContentHash(raw) })
    } catch (err) {
      log.warn('Failed to record the seeded content hash', { noteId, error: err })
    }
  }

  async seedFromMarkdownPublic(noteId: string): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry) return
    await this.seedFromMarkdown(noteId, entry.doc)
  }

  async initForNote(
    noteId: string,
    meta: { title?: string; date?: string },
    tags?: string[]
  ): Promise<Y.Doc> {
    const doc = await this.open(noteId)

    doc.transact(() => {
      const metaMap = doc.getMap('meta')
      if (meta.title && !metaMap.get('title')) metaMap.set('title', meta.title)
      if (meta.date && !metaMap.get('date')) metaMap.set('date', meta.date)

      if (tags?.length) {
        const tagArray = doc.getArray('tags')
        if (tagArray.length === 0) {
          tagArray.push(tags)
        }
      }
    }, ORIGIN_LOCAL)

    return doc
  }

  updateMeta(noteId: string, meta: { title?: string; date?: string }): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)

    entry.doc.transact(() => {
      const metaMap = entry.doc.getMap('meta')
      if (meta.title !== undefined) metaMap.set('title', meta.title)
      if (meta.date !== undefined) metaMap.set('date', meta.date)
    }, ORIGIN_LOCAL)
  }

  async seedExistingDocs(
    entries: Array<{ id: string; title?: string; date?: string; tags?: string[] }>,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const BATCH_SIZE = 50
    let seeded = 0

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      if (signal?.aborted) {
        log.info('CRDT seed aborted', { seeded, total: entries.length })
        return seeded
      }

      const batch = entries.slice(i, i + BATCH_SIZE)

      for (const entry of batch) {
        if (this.docs.has(entry.id)) continue
        if (this.persistence) {
          try {
            const existing = await this.persistence.getYDoc(entry.id)
            const hasContent = Y.encodeStateAsUpdate(existing).length > 4
            existing.destroy()
            if (hasContent) continue
          } catch (err) {
            log.warn('Failed to read persisted doc during seeding; skipping', {
              noteId: entry.id,
              error: err
            })
            continue
          }
        }

        await this.initForNote(entry.id, { title: entry.title, date: entry.date }, entry.tags)
        await this.closeIfInactive(entry.id)
        seeded++
      }

      onProgress?.(Math.min(i + BATCH_SIZE, entries.length), entries.length)

      if (i + BATCH_SIZE < entries.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }

    log.info('Seeded existing docs', { seeded, total: entries.length })
    return seeded
  }

  private onDocUpdate(noteId: string, update: Uint8Array, origin: unknown): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    this.touchDoc(entry)
    // Both counters stay honest for a local-only note. accumulatedBytes drives
    // local compaction, which a local-only doc needs like any other; and
    // pendingSnapshotBytes means "written locally, not yet on the server", which
    // is exactly true here. Suppressing the debt would make the guards below
    // read as redundant when they are the only thing holding the body back.
    entry.accumulatedBytes += update.byteLength
    if (origin !== ORIGIN_NETWORK) {
      entry.pendingSnapshotBytes += update.byteLength
    }

    if (isIpcOrigin(origin)) {
      this.broadcastToWindows(noteId, update, 'ipc', origin.windowId)
    } else if (origin === ORIGIN_NETWORK) {
      this.queueNetworkBroadcast(noteId, update)
    } else {
      this.broadcastToWindows(noteId, update, ORIGIN_LOCAL, undefined)
    }

    this.persistUpdate(noteId, update)
    this.maybeCompact(noteId)

    // Everything above this line is local — the doc, the local CRDT store, the
    // window broadcast, the markdown write-back scheduled below — and stays
    // exactly the same for a local-only note. This is the only branch that
    // sends bytes off the machine, and it is the one the record feed already
    // refuses for the same notes (`seedUnclockedNotes`, `offline-clock`).
    // Recording a full-state row is skipped for the same reason the push is:
    // that row exists to get a body to the server.
    if (origin !== ORIGIN_NETWORK && !entry.localOnly) {
      if (this.updateQueue) {
        this.updateQueue.enqueue(noteId, update)
      } else {
        this.recordUnqueuedUpdate(noteId)
      }
    }

    if (origin === ORIGIN_NETWORK) {
      recordNetworkUpdate(noteId)
    }

    if (origin === ORIGIN_NETWORK || isIpcOrigin(origin)) {
      scheduleWriteback(noteId, entry.doc)
    }
  }

  /**
   * Remember a local edit that had no outbox to hand it to.
   *
   * `init(outbox, ...)` runs from `startSyncRuntime` and nowhere else, and
   * `destroy()` nulls it again, so with no session — signed out, not on a paid
   * plan — there is no outbox. The update still reaches the doc and the local
   * CRDT store; what the server is owed is recorded as one full-state row in
   * this vault's sync_queue, which the next runtime's outbox pushes. Full state
   * rather than one row per update: an install that never syncs would
   * otherwise grow sync_queue by every keystroke it ever makes.
   *
   * Deduped per note for the queue-less stretch, so this is one small
   * synchronous write per *note touched*. The mark goes up before the write so
   * a database that cannot be written does not turn every later keystroke into
   * another failing write.
   */
  private recordUnqueuedUpdate(noteId: string): void {
    if (this.recordedUnqueuedNotes.has(noteId)) return
    this.recordedUnqueuedNotes.add(noteId)
    this.recordOwedFullState(noteId)
    log.debug('Recorded a local CRDT edit made with no outbox', { noteId })
  }

  private recordOwedFullState(noteId: string): void {
    if (this.updateQueue) return this.updateQueue.enqueueFullState(noteId)
    this.writeWithoutRuntime(noteId, (queue) =>
      queue.enqueueNoteBody(noteId, NOTE_BODY_FULL_STATE_PAYLOAD)
    )
  }

  private dropOwedBody(noteId: string): void {
    if (this.updateQueue) return this.updateQueue.dropNote(noteId)
    this.writeWithoutRuntime(noteId, (queue) => queue.removeNoteBody(noteId))
  }

  /**
   * With no sync runtime the rows still go to this vault's sync_queue, where
   * the next runtime's outbox finds them. A failed write is logged, not
   * thrown: this runs on the edit path, and the edit itself is already safe in
   * the local doc and store.
   */
  private writeWithoutRuntime(noteId: string, write: (queue: SyncQueueManager) => void): void {
    try {
      write(new SyncQueueManager(getDatabase()))
    } catch (err) {
      log.error('Could not write the CRDT body outbox with no sync runtime', {
        noteId,
        error: err
      })
    }
  }

  private broadcastToWindows(
    noteId: string,
    update: Uint8Array,
    origin: string,
    sourceWindowId: number | undefined
  ): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (entry.windowIds.size === 0) {
      log.debug('No windows to broadcast CRDT update', { noteId, origin })
      return
    }

    for (const windowId of entry.windowIds) {
      if (windowId === sourceWindowId) continue

      const win = BrowserWindow.fromId(windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CRDT_EVENTS.STATE_CHANGED, {
          noteId,
          update,
          origin
        })
      } else {
        // Backstop for a window whose 'closed' hook never ran (opened the note
        // before the hook was registered, or the provider was replaced by a
        // vault switch): drop the id so it stops pinning the doc. A hidden or
        // minimised window still resolves here, so this only ever sheds ids
        // whose window is genuinely gone. Deliberately does not close the doc —
        // this runs inside the doc's own 'update' handler — it just makes the
        // doc eligible for the normal inactive-doc eviction pass.
        entry.windowIds.delete(windowId)
        log.debug('Dropped CRDT broadcast target for a window that is gone', { noteId, windowId })
      }
    }
  }

  private queueNetworkBroadcast(noteId: string, update: Uint8Array): void {
    this.networkBatcher.enqueue(noteId, update)
  }

  private flushNetworkBroadcast(noteId: string): void {
    this.networkBatcher.flush(noteId)
  }

  private persistUpdate(noteId: string, update: Uint8Array): void {
    if (!this.persistence) return
    this.persistence.storeUpdate(noteId, update).catch((err) => {
      log.error('Failed to persist CRDT update', { noteId, error: err })
    })
  }

  private maybeCompact(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    if (entry.accumulatedBytes < ACCUMULATED_BYTES_RECHECK_THRESHOLD) return
    if (this.compactingDocs.has(noteId)) return

    const now = Date.now()
    if (now - entry.lastSizeCheckAt < SIZE_CHECK_INTERVAL_MS) return

    setImmediate(() => this.checkAndCompact(noteId))
  }

  private checkAndCompact(noteId: string): void {
    const entry = this.docs.get(noteId)
    if (!entry) return

    entry.lastSizeCheckAt = Date.now()
    const encoded = Y.encodeStateAsUpdate(entry.doc)
    entry.lastEncodedSize = encoded.byteLength

    if (entry.lastEncodedSize > ENCODED_SIZE_COMPACTION_THRESHOLD && entry.windowIds.size === 0) {
      entry.accumulatedBytes = 0
      this.compactDoc(noteId).catch((err) => {
        log.error('Failed to compact doc', { noteId, error: err })
      })
    } else if (entry.accumulatedBytes > ENCODED_SIZE_COMPACTION_THRESHOLD) {
      entry.accumulatedBytes = 0
      this.flushDoc(noteId).catch((err) => {
        log.error('Failed to flush doc', { noteId, error: err })
      })
    }
  }

  private async flushDoc(noteId: string): Promise<void> {
    if (!this.persistence) return
    await this.persistence.flushDocument(noteId)
  }

  private touchDoc(entry: ActiveDoc): void {
    entry.lastTouchedAt = this.now()
  }

  private measureDocSize(noteId: string, entry: ActiveDoc): CrdtDocSizeMetric {
    const encodedSizeBytes = Y.encodeStateAsUpdate(entry.doc).byteLength
    entry.lastEncodedSize = encodedSizeBytes
    return {
      noteId,
      encodedSizeBytes,
      accumulatedBytes: entry.accumulatedBytes,
      pendingSnapshotBytes: entry.pendingSnapshotBytes,
      windowCount: entry.windowIds.size,
      lastTouchedAt: entry.lastTouchedAt
    }
  }

  private async evictInactiveDocsIfNeeded(): Promise<void> {
    const inactiveDocs = Array.from(this.docs.entries()).filter(
      ([, entry]) => entry.windowIds.size === 0 && !entry.closing
    )
    const overflow = inactiveDocs.length - this.inactiveDocCapacity
    if (overflow <= 0) return

    inactiveDocs.sort(([, left], [, right]) => left.lastTouchedAt - right.lastTouchedAt)

    for (const [noteId] of inactiveDocs.slice(0, overflow)) {
      await this.closeIfInactive(noteId)
    }
  }

  async compactDoc(noteId: string): Promise<void> {
    const entry = this.docs.get(noteId)
    if (!entry) return

    if (entry.closing) {
      log.debug('Skipping compaction: doc is closing', { noteId })
      return
    }

    if (entry.windowIds.size > 0) {
      log.debug('Skipping compaction: editors open', { noteId, windowCount: entry.windowIds.size })
      return
    }

    if (this.compactingDocs.has(noteId)) return

    // The base is read up front; the claim and the compaction still share one
    // synchronous step after it (the checks above are re-run after the await).
    const base = await this.readPushBase(noteId)
    if (entry.closing || entry.windowIds.size > 0 || this.compactingDocs.has(noteId)) return
    if (this.docs.get(noteId) !== entry) return
    const compaction: { result: ReturnType<typeof compactYDoc> } = { result: null }
    const { coverage } = this.encodeForPush(base, () => {
      compaction.result = compactYDoc(entry.doc, CRDT_FRAGMENT_NAME)
      return compaction.result?.compacted ?? new Uint8Array()
    })
    const result = compaction.result
    if (!result) return

    const beforeSize = entry.lastEncodedSize
    log.info('Compacting doc', {
      noteId,
      beforeSize,
      afterSize: result.compacted.byteLength,
      savedBytes: result.savedBytes
    })

    this.compactingDocs.add(noteId)
    this.compactionBuffers.set(noteId, [])

    try {
      if (this.snapshotPushFn && entry.pendingSnapshotBytes > 0 && !entry.localOnly) {
        // Credit only the bytes this payload actually covers. result.compacted
        // was encoded before the await, and applyIpcUpdate writes straight to
        // entry.doc with no compaction guard (only remote updates are
        // buffered), so a local edit landing during the push is genuinely
        // unpushed. Zeroing wiped it, and every path that re-pushes a note —
        // close() and pushAllSnapshots — is gated on this counter, so the note
        // read as pushed and stayed unpushed until a later edit re-armed it.
        // Clamped: close() may have zeroed the counter mid-push.
        const pushedBytes = entry.pendingSnapshotBytes
        await this.snapshotPushFn(noteId, result.compacted, coverage)
        entry.pendingSnapshotBytes = Math.max(0, entry.pendingSnapshotBytes - pushedBytes)
      }

      if (this.persistence) {
        await this.persistence.storeUpdate(noteId, result.compacted)
        await this.persistence.flushDocument(noteId)
      }

      // close() only flips `entry.closing` and then deletes (or lets doOpen
      // replace) the map entry — it never consults compaction state, so the
      // entry captured above can be retired, and the note reopened onto a
      // fresh entry, while the pushes above are in flight. Comparing entry
      // identity is what catches that: swapping `entry.doc` on a detached
      // entry would drop the compaction into an object nothing reads, and
      // strand the remote updates buffered for it.
      const live = this.docs.get(noteId)
      if (live !== entry || live?.closing || entry.windowIds.size > 0) {
        log.info('Compaction abandoned: the doc was reopened, closed or replaced mid-compaction', {
          noteId,
          replaced: live !== entry,
          closing: live?.closing === true,
          windowCount: entry.windowIds.size
        })
        this.drainCompactionBuffer(noteId, live)
        return
      }

      const oldDoc = entry.doc
      const newDoc = new Y.Doc()
      // Seeded before the handler is attached on purpose: result.compacted was
      // already pushed and persisted above, so routing it through onDocUpdate
      // would store and broadcast the whole snapshot a second time.
      Y.applyUpdate(newDoc, result.compacted)

      newDoc.on('update', (update: Uint8Array, origin: unknown) => {
        this.onDocUpdate(noteId, update, origin)
      })

      entry.doc = newDoc
      entry.accumulatedBytes = 0
      entry.lastEncodedSize = result.compacted.byteLength
      entry.lastSizeCheckAt = Date.now()

      oldDoc.destroy()

      // Replay the buffer only after the swap, so the updates land on the doc
      // this.docs points at and go through the handler. onDocUpdate is the
      // single funnel for persistUpdate, queueNetworkBroadcast and
      // scheduleWriteback; replaying ahead of it left the compaction window's
      // remote updates in memory only — dropped from the CRDT store, from the
      // vault markdown file and from the broadcast — on every successful
      // compaction that buffered at least one update. Still inside the try, so
      // compactingDocs holds noteId and onDocUpdate's maybeCompact cannot
      // re-enter.
      this.drainCompactionBuffer(noteId, entry)

      log.info('Doc compacted', { noteId, beforeSize, afterSize: result.compacted.byteLength })
    } finally {
      this.compactingDocs.delete(noteId)
      // Still here only when the push or the store write threw.
      if (this.compactionBuffers.get(noteId)?.length) this.oweDroppedRemoteUpdates(noteId)
      this.compactionBuffers.delete(noteId)
    }
  }

  /**
   * Remote updates buffered for a compaction were dropped: their sequences are
   * already recorded as applied and the feed cursor may be past them, so the
   * note is owed its whole server body and flagged until that merges (#2299).
   * The watermark is dropped either way, or a probe would call the note merged
   * (#2297 review B-H2). With no runtime the debt is written straight to the
   * data DB of this store's vault, which the next engine start hydrates; with
   * that DB closed or unusable it is kept in this store until a runtime
   * attaches (#2421).
   */
  private oweDroppedRemoteUpdates(noteId: string): void {
    void this.forgetSnapshotWatermark(noteId)
    if (!this.oweRemoteMerge) {
      log.warn('Dropped remote updates buffered during compaction with no sync runtime', {
        noteId
      })
      void this.oweDetachedCompaction(noteId)
      return
    }
    log.warn('Dropped remote updates buffered during compaction; owing the note a pull', {
      noteId
    })
    this.oweRemoteMerge(noteId, 'compaction')
  }

  private oweDetachedCompaction(noteId: string): Promise<void> {
    try {
      const db = this.boundVaultDatabase()
      const debts = db && crdtBodyDebtStore(db)
      if (debts?.durable()) {
        debts.owe([noteId], 'compaction', { needsWalk: true })
        return Promise.resolve()
      }
    } catch (err) {
      log.error('Could not owe a compaction in the data DB; keeping it in the store', {
        noteId,
        error: err
      })
    }
    return this.withOwedCompactions(async (persistence) => {
      const owed = await persistence.getMeta(OWED_COMPACTIONS_DOC, OWED_COMPACTIONS_KEY)
      const noteIds = new Set(Array.isArray(owed) ? owed : [])
      noteIds.add(noteId)
      await persistence.setMeta(OWED_COMPACTIONS_DOC, OWED_COMPACTIONS_KEY, [...noteIds])
    }, 'Could not record a compaction owed with no sync runtime')
  }

  /** The bound data DB, while it is the open one and still this store's vault. */
  private boundVaultDatabase(): DrizzleDb | null {
    const bound = this.boundVault
    if (!bound || !isDatabaseInitialized() || getDatabase() !== bound.db) return null
    if (getOrCreateVaultUuid(bound.db) !== bound.vaultUuid) return null
    return bound.db as unknown as DrizzleDb
  }

  /**
   * Hand the updates buffered for a finished compaction to whatever doc is live
   * now — the compacted replacement on the happy path, or the doc that took its
   * place when the compaction was abandoned. applyRemoteUpdate diverts remote
   * updates into this buffer for the whole compaction window and reports
   * nothing back to the sync coordinator, which has already recorded those
   * sequence numbers as applied — so a buffer that is discarded, or replayed
   * into a doc with no 'update' handler, is a silently lost remote update, not
   * a retried one.
   *
   * Always call this with the entry `this.docs` currently holds: applying to a
   * detached entry would resurrect the update into a doc nothing reads.
   */
  private drainCompactionBuffer(noteId: string, target: ActiveDoc | undefined): void {
    const buffered = this.compactionBuffers.get(noteId)
    this.compactionBuffers.delete(noteId)
    if (!buffered?.length) return
    if (!target || target.doc.isDestroyed) {
      this.oweDroppedRemoteUpdates(noteId)
      return
    }

    for (const update of buffered) {
      Y.applyUpdate(target.doc, update, ORIGIN_NETWORK)
    }
    log.debug('Replayed remote updates buffered for an abandoned compaction', {
      noteId,
      count: buffered.length
    })
  }

  /**
   * Validate that a note exists and is eligible for CRDT (non-binary).
   * Routed through the provider so IPC handlers stay decoupled from the
   * database query layer (architecture boundary).
   */
  validateNoteForCrdt(noteId: string): { ok: true } | { ok: false; error: string } {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, noteId)
    if (!cached) return { ok: false, error: `Note not found: ${noteId}` }
    if (cached.fileType && isBinaryFileType(cached.fileType)) {
      return { ok: false, error: `Binary notes do not use CRDT: ${noteId}` }
    }
    return { ok: true }
  }

  /**
   * May the CRDT feed still carry this note's body to the server?
   *
   * The union of both refusals, for the note-body outbox — which has to decide
   * whether a full-state row is still owed a push at all. The
   * two halves stay separate because `validateNoteForCrdt` also gates the
   * renderer's editor handshake, and a local-only note opens and edits there
   * like any other; only its *sync* is off.
   */
  isNoteSyncable(noteId: string): boolean {
    return this.validateNoteForCrdt(noteId).ok && !this.isNoteLocalOnly(noteId)
  }

  applyIpcUpdate(noteId: string, update: Uint8Array, sourceWindowId: number): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)

    const origin: IpcOrigin = { source: 'ipc', windowId: sourceWindowId }
    Y.applyUpdate(entry.doc, update, origin)
  }

  applyIpcSyncStep2(noteId: string, diff: Uint8Array): void {
    const entry = this.docs.get(noteId)
    if (!entry) return
    this.touchDoc(entry)
    Y.applyUpdate(entry.doc, diff, { source: 'ipc', windowId: -1 } satisfies IpcOrigin)
  }
}

function isIpcOrigin(origin: unknown): origin is IpcOrigin {
  return (
    typeof origin === 'object' &&
    origin !== null &&
    'source' in origin &&
    (origin as IpcOrigin).source === 'ipc'
  )
}

let sessionOutcomeRecorded = false

/**
 * Count this LAUNCH once, not each store this launch opens.
 *
 * A vault switch brings up a second provider, and a user who switches five
 * times would otherwise look like five degraded launches — which is the number
 * the user-facing notice is thresholded on. The first verdict of the process is
 * the honest one; the rest of the session is the same binary and the same
 * machine.
 *
 * There is deliberately no bounded retry behind this. The failure it counts is
 * a native abort in the binding, which issue #1583 shows is deterministic per
 * machine (19/19 win32 installs, every launch, six releases) rather than
 * transient, and every retry costs a multi-second child process on the launch
 * path. The one transient-shaped cause — a utility process that cannot boot —
 * already gets its retry inside a single `openCrdtPersistence` call, on the
 * Chromium-free transport.
 */
function recordSessionPersistenceOutcome(healthy: boolean): void {
  if (sessionOutcomeRecorded) return
  sessionOutcomeRecorded = true
  try {
    const sessions = recordCrdtPersistenceOutcome(healthy)
    if (sessions > 0) {
      log.warn('CRDT persistence has been unavailable for consecutive launches', { sessions })
    }
  } catch (err) {
    // Bookkeeping for a notice must never be what stops the store from opening.
    log.warn('Could not record the CRDT persistence outcome', { error: err })
  }
}

/** Test seam for the once-per-launch latch above. */
export function _resetCrdtSessionOutcomeForTests(): void {
  sessionOutcomeRecorded = false
}

let instance: CrdtProvider | null = null

export function getCrdtProvider(): CrdtProvider {
  if (!instance) {
    instance = new CrdtProvider()
  }
  return instance
}

export function resetCrdtProvider(): void {
  const previous = instance
  instance = null
  if (!previous) return

  // Renderer providers hold a note open against the instance just dropped, and
  // nothing else tells them it is gone: the next remote update is applied to a
  // doc in the fresh instance and broadcast to a window set that no longer
  // contains the editor, so the note silently goes stale until it is closed and
  // reopened. Tell every window its binding is dead.
  //
  // Dead, not retryable-now. This runs mid-teardown — sign-out calls it with the
  // old provider destroyed and no replacement initialized — so a window that
  // answered by re-opening got 'CRDT provider not initialized' every single
  // time. The re-open is driven by PROVIDER_READY instead, emitted when a
  // provider can actually serve it.
  broadcastToAllWindows(CRDT_EVENTS.PROVIDER_RESET)
  log.info('CRDT provider reset, marked window editors stale', {
    strandedEditorDocs: previous.strandedEditorDocCount
  })
}
