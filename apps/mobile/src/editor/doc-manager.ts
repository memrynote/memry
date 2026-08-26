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
 * Two rules this module exists to enforce:
 *
 * 1. DURABILITY (T062). Every WebView-originated update is committed to SQLite
 *    BEFORE it is acked into the outbox. An app kill between the two loses
 *    nothing: the update is on disk and the outbox scan picks it up. Doing it
 *    in the other order produces an update the server was told about that no
 *    longer exists locally.
 *
 * 2. BOTH HALVES. Server-pulled CRDT rows are keyed by the bare doc id with the
 *    SERVER's sequence numbers; locally-originated updates live under
 *    `local.<docId>` with their own sequence, so a local append can never
 *    collide with a future server row. A doc is only complete when both halves
 *    are replayed — reading one is a doc missing the other side's edits.
 */

export interface DocHalves {
  snapshot: Uint8Array | null
  updates: Uint8Array[]
}

export interface DocStore {
  /** Rows the pull engine wrote: bare doc id, server sequence. */
  loadServerHalf(docId: string): Promise<DocHalves>
  /** Rows this device wrote: `local.<docId>` namespace, local sequence. */
  loadLocalHalf(docId: string): Promise<DocHalves>
  /** MUST resolve only once the row is committed. */
  appendLocalUpdate(docId: string, update: Uint8Array): Promise<void>
}

export interface OutboxSink {
  enqueueCrdtUpdate(docId: string, update: Uint8Array): Promise<void>
}

/** Origin tags. Identity comparison, so they can never collide with a string. */
export const ORIGIN_REMOTE = Symbol('memry-remote')
export const ORIGIN_GUEST = Symbol('memry-guest')

export interface OpenDoc {
  docId: string
  doc: Y.Doc
  /** Full state to hand the WebView in `doc-load`. */
  encodeState(): Uint8Array
  /** A WebView-originated update: persist, then ack into the outbox. */
  applyFromGuest(update: Uint8Array): Promise<void>
  /** A sync-originated update: persist is the pull engine's job, not ours. */
  applyFromRemote(update: Uint8Array): void
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
  openDoc(docId: string): Promise<OpenDoc> {
    let pending = this.open.get(docId)
    if (!pending) {
      pending = this.load(docId)
      this.open.set(docId, pending)
      pending.catch(() => this.open.delete(docId))
    }
    return pending
  }

  /** True when the doc is already in memory — the process-death fast path. */
  isOpen(docId: string): boolean {
    return this.open.has(docId)
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

    return {
      docId,
      doc,
      encodeState: () => Y.encodeStateAsUpdate(doc),

      async applyFromGuest(update) {
        Y.applyUpdate(doc, update, ORIGIN_GUEST)
        // ORDER IS THE CONTRACT: durable first, ack second.
        await store.appendLocalUpdate(docId, update)
        await outbox.enqueueCrdtUpdate(docId, update)
      },

      applyFromRemote(update) {
        Y.applyUpdate(doc, update, ORIGIN_REMOTE)
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
