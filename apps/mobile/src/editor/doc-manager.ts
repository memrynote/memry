import * as Y from 'yjs'
import { createLogger } from '../lib/logger'

const log = createLogger('EditorDocManager')

/**
 * RN-side Y.Doc ownership (T061).
 *
 * The doc lives here, not in the WebView — mirroring Electron main-process
 * ownership — because iOS evicts WKWebView storage and a replica that is also
 * the source of truth loses unsynced writes silently.
 *
 * Three rules this module exists to enforce:
 *
 * 1. DURABILITY (T062). Every WebView-originated update is committed to SQLite
 *    BEFORE it is acked into the outbox, and — in production — in the SAME
 *    transaction, so the pair cannot half-happen. An app kill between the two
 *    would otherwise leave an update that is durable locally and that nothing
 *    will ever push: invisible, permanent divergence.
 *
 * 2. BOTH HALVES. Server-pulled CRDT rows are keyed by the bare doc id with the
 *    SERVER's sequence numbers; locally-originated updates live under
 *    `local.<docId>` with their own sequence, so a local append can never
 *    collide with a future server row. A doc is only complete when both halves
 *    are replayed — reading one is a doc missing the other side's edits.
 *
 * 3. STAYING CURRENT. Docs are cached for the process lifetime, so a pull that
 *    lands new server rows has to be fed in explicitly (`refreshFromServer`).
 *    Without that, a desktop edit is invisible in an open editor and stays
 *    invisible after navigating away and back.
 */

export interface DocHalves {
  snapshot: Uint8Array | null
  updates: Uint8Array[]
  /** Highest sequence folded into `snapshot`/`updates`; 0 when empty. */
  lastSeq: number
}

export interface SequencedUpdate {
  seq: number
  update: Uint8Array
}

/**
 * What arrived on the server side since a given watermark.
 *
 * A snapshot has to be in here, not just loose updates: the pull path FOLDS
 * updates into a snapshot and deletes the rows it folded, so a doc that only
 * re-read `yjs_updates` would see nothing, advance its watermark past the
 * folded range, and show a stale body for the rest of the process — exactly
 * the case the refresh exists to prevent.
 */
export interface ServerDelta {
  /** Present when the stored snapshot is newer than the caller's watermark. */
  snapshot: Uint8Array | null
  snapshotSeq: number
  updates: SequencedUpdate[]
}

export interface DocStore {
  /** Rows the pull engine wrote: bare doc id, server sequence. */
  loadServerHalf(docId: string): Promise<DocHalves>
  /** Rows this device wrote: `local.<docId>` namespace, local sequence. */
  loadLocalHalf(docId: string): Promise<DocHalves>
  /** Server-side CRDT state written after `sinceSeq`. */
  loadServerUpdatesSince(docId: string, sinceSeq: number): Promise<ServerDelta>
  /** MUST resolve only once the row is committed. */
  appendLocalUpdate(docId: string, update: Uint8Array): Promise<void>
  /**
   * Run the persist + ack pair inside one transaction.
   *
   * Optional so tests can observe the two steps separately; supplied in
   * production, where atomicity is what makes rule 1 unbreakable rather than
   * merely well-ordered.
   */
  withCommit?<T>(fn: () => Promise<T>): Promise<T>
  /**
   * Fold the local half into a snapshot once it has grown past the threshold.
   *
   * The store decides WHICH sequence it folded to, inside its own transaction:
   * the doc manager only counts loose updates, and handing that count over as
   * a sequence is how the first fold prunes nothing and the local half then
   * grows without bound. Safe because guest updates are persisted one at a
   * time, so nothing is appended between the snapshot and the fold.
   */
  compactLocal?(docId: string, snapshot: Uint8Array): Promise<void>
}

export interface OutboxSink {
  enqueueCrdtUpdate(docId: string, update: Uint8Array): Promise<void>
}

/** Origin tags. Identity comparison, so they can never collide with a string. */
export const ORIGIN_REMOTE = Symbol('memry-remote')
export const ORIGIN_GUEST = Symbol('memry-guest')

/**
 * Local updates kept loose before the doc is snapshotted.
 *
 * Every open replays the whole local half, so an actively-edited note would
 * otherwise accumulate thousands of rows and open slower every day.
 */
export const LOCAL_COMPACT_THRESHOLD = 200

export interface OpenDoc {
  docId: string
  doc: Y.Doc
  /** Full state to hand the WebView in `doc-load`. */
  encodeState(): Uint8Array
  /** True when the document holds no content at all. */
  isEmpty(): boolean
  /** A WebView-originated update: persist, then ack into the outbox. */
  applyFromGuest(update: Uint8Array): Promise<void>
  /** A sync-originated update: persisting it is the pull engine's job. */
  applyFromRemote(update: Uint8Array): void
  /** Pull in server rows written since this doc was loaded. */
  refreshFromServer(): Promise<number>
  /** Fires for updates the local doc produced that the WebView has not seen. */
  onLocalUpdate(listener: (update: Uint8Array) => void): () => void
  /** Fires for remote updates that must be forwarded to the WebView. */
  onRemoteUpdate(listener: (update: Uint8Array) => void): () => void
  close(): void
}

/**
 * Open docs kept in memory.
 *
 * The cache exists so WebView process death is cheap, but a session that
 * visits a hundred notes should not be holding a hundred Y.Docs — on a
 * memory-constrained device that is exactly what gets the app killed. Eviction
 * is least-recently-opened, and evicting is free: everything a doc holds is
 * already on disk.
 */
export const MAX_OPEN_DOCS = 8

export class EditorDocManager {
  /** Insertion order IS the LRU order — a reopen re-inserts at the end. */
  private open = new Map<string, Promise<OpenDoc>>()

  constructor(
    private readonly store: DocStore,
    private readonly outbox: OutboxSink
  ) {}

  /**
   * Open (or reuse) a doc. Reused deliberately: the WebView can be torn down
   * and re-created by iOS at any moment, and re-reading SQLite on every
   * re-create would make process death expensive as well as invisible.
   */
  async openDoc(docId: string): Promise<OpenDoc> {
    const cached = this.open.get(docId)
    if (cached) {
      // Re-insert to mark it most-recently-used.
      this.open.delete(docId)
      this.open.set(docId, cached)
      const doc = await cached
      // Reusing a cached doc without this is how a desktop edit stays
      // invisible after navigating away and back: the rows are in SQLite, the
      // in-memory doc simply never read them.
      await doc.refreshFromServer()
      return doc
    }

    const pending = this.load(docId)
    this.open.set(docId, pending)
    pending.catch(() => this.open.delete(docId))
    void this.evictOldest()
    return pending
  }

  /**
   * Drop the least-recently-opened docs past the cap.
   *
   * Safe by construction: an update is durable before it reaches the doc, so a
   * closed doc has nothing that is not already on disk.
   */
  private async evictOldest(): Promise<void> {
    while (this.open.size > MAX_OPEN_DOCS) {
      const oldest = this.open.keys().next().value
      if (oldest === undefined) return
      await this.closeDoc(oldest)
    }
  }

  /** True when the doc is already in memory — the process-death fast path. */
  isOpen(docId: string): boolean {
    return this.open.has(docId)
  }

  /** Feed newly-pulled server rows into whichever docs are open. */
  async refreshOpenDocs(docIds: string[]): Promise<void> {
    for (const docId of docIds) {
      const pending = this.open.get(docId)
      if (!pending) continue
      try {
        await (await pending).refreshFromServer()
      } catch (err) {
        log.warn('Refreshing an open doc failed', {
          docId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  async closeDoc(docId: string): Promise<void> {
    const pending = this.open.get(docId)
    if (!pending) return
    this.open.delete(docId)
    try {
      ;(await pending).close()
    } catch (err) {
      log.warn('Doc close failed', {
        docId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  closeAll(): void {
    for (const docId of [...this.open.keys()]) void this.closeDoc(docId)
  }

  private async load(docId: string): Promise<OpenDoc> {
    const [server, local] = await Promise.all([
      this.store.loadServerHalf(docId),
      this.store.loadLocalHalf(docId)
    ])

    const doc = new Y.Doc()
    // Snapshots first, then updates. Yjs is order-independent for correctness,
    // but replaying a snapshot after the updates it already contains is pure
    // work on the open path.
    doc.transact(() => {
      for (const half of [server, local]) {
        if (half.snapshot) Y.applyUpdate(doc, half.snapshot, ORIGIN_REMOTE)
        for (const update of half.updates) Y.applyUpdate(doc, update, ORIGIN_REMOTE)
      }
    }, ORIGIN_REMOTE)

    let serverSeq = server.lastSeq
    let looseLocal = local.updates.length

    const localListeners = new Set<(update: Uint8Array) => void>()
    const remoteListeners = new Set<(update: Uint8Array) => void>()

    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === ORIGIN_GUEST) {
        // Already in the WebView — it is where the update came from.
        for (const listener of localListeners) listener(update)
        return
      }
      if (origin === ORIGIN_REMOTE) {
        for (const listener of remoteListeners) listener(update)
      }
    }
    doc.on('update', onUpdate)

    const store = this.store
    const outbox = this.outbox
    const run = <T>(fn: () => Promise<T>): Promise<T> =>
      store.withCommit ? store.withCommit(fn) : fn()

    const maybeCompact = async (): Promise<void> => {
      if (!store.compactLocal || looseLocal < LOCAL_COMPACT_THRESHOLD) return
      const snapshot = Y.encodeStateAsUpdate(doc)
      try {
        await store.compactLocal(docId, snapshot)
        looseLocal = 0
      } catch (err) {
        // Compaction is an optimisation; a failure must not lose the update
        // that triggered it, so the loose rows simply stay loose.
        log.warn('Local CRDT compaction failed', {
          docId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    return {
      docId,
      doc,
      encodeState: () => Y.encodeStateAsUpdate(doc),
      isEmpty: () => doc.getXmlFragment('prosemirror').length === 0,

      async applyFromGuest(update) {
        // ORDER IS THE CONTRACT: durable first, ack second — atomically in
        // production, so a kill between them cannot leave an update that is
        // saved locally and that nothing will ever push.
        //
        // And the owned doc is only advanced AFTER the commit. Applying first
        // and committing second means a failed commit leaves an update that
        // exists only in memory, with every later delta built on top of it:
        // the whole tail of the editing session is lost on the next open, with
        // no symptom until then. Failing before the doc moves keeps the doc
        // and the disk in agreement, and the caller resyncs the WebView from
        // that agreed state.
        await run(async () => {
          await store.appendLocalUpdate(docId, update)
          await outbox.enqueueCrdtUpdate(docId, update)
        })
        Y.applyUpdate(doc, update, ORIGIN_GUEST)
        looseLocal += 1
        await maybeCompact()
      },

      applyFromRemote(update) {
        Y.applyUpdate(doc, update, ORIGIN_REMOTE)
      },

      async refreshFromServer() {
        const delta = await store.loadServerUpdatesSince(docId, serverSeq)
        const applied = delta.updates.length + (delta.snapshot ? 1 : 0)
        if (applied === 0) return 0

        doc.transact(() => {
          // Snapshot first: it is the folded state the loose rows sit on top
          // of. Yjs merges idempotently, so re-applying anything it already
          // contains costs nothing.
          if (delta.snapshot) {
            Y.applyUpdate(doc, delta.snapshot, ORIGIN_REMOTE)
            if (delta.snapshotSeq > serverSeq) serverSeq = delta.snapshotSeq
          }
          for (const row of delta.updates) {
            Y.applyUpdate(doc, row.update, ORIGIN_REMOTE)
            if (row.seq > serverSeq) serverSeq = row.seq
          }
        }, ORIGIN_REMOTE)
        return applied
      },

      onLocalUpdate(listener) {
        localListeners.add(listener)
        return () => localListeners.delete(listener)
      },

      onRemoteUpdate(listener) {
        remoteListeners.add(listener)
        return () => remoteListeners.delete(listener)
      },

      close() {
        doc.off('update', onUpdate)
        localListeners.clear()
        remoteListeners.clear()
        doc.destroy()
      }
    }
  }
}
