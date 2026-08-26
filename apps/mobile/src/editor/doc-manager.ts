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

export interface DocStore {
  /** Rows the pull engine wrote: bare doc id, server sequence. */
  loadServerHalf(docId: string): Promise<DocHalves>
  /** Rows this device wrote: `local.<docId>` namespace, local sequence. */
  loadLocalHalf(docId: string): Promise<DocHalves>
  /** Server rows appended after `sinceSeq`, oldest first. */
  loadServerUpdatesSince(docId: string, sinceSeq: number): Promise<SequencedUpdate[]>
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
  /** Fold the local half into a snapshot once it has grown past `threshold`. */
  compactLocal?(docId: string, snapshot: Uint8Array, upToSeq: number): Promise<void>
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

export class EditorDocManager {
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
    return pending
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
      const folded = looseLocal
      try {
        await store.compactLocal(docId, snapshot, folded)
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
        Y.applyUpdate(doc, update, ORIGIN_GUEST)
        // ORDER IS THE CONTRACT: durable first, ack second — and atomically in
        // production, so a kill between them cannot leave an update that is
        // saved locally and that nothing will ever push.
        await run(async () => {
          await store.appendLocalUpdate(docId, update)
          await outbox.enqueueCrdtUpdate(docId, update)
        })
        looseLocal += 1
        await maybeCompact()
      },

      applyFromRemote(update) {
        Y.applyUpdate(doc, update, ORIGIN_REMOTE)
      },

      async refreshFromServer() {
        const rows = await store.loadServerUpdatesSince(docId, serverSeq)
        if (rows.length === 0) return 0
        doc.transact(() => {
          for (const row of rows) {
            Y.applyUpdate(doc, row.update, ORIGIN_REMOTE)
            if (row.seq > serverSeq) serverSeq = row.seq
          }
        }, ORIGIN_REMOTE)
        return rows.length
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
