/**
 * The per-note snapshot watermark, stored **inside the per-vault CRDT store**.
 *
 * The watermark is the sweep's licence to skip a note's snapshot baseline: it
 * says "this document already holds the server snapshot `snapshotRevision`, and
 * everything at or below sequence `appliedSequence`". A watermark that outlives
 * the document it describes therefore makes the sweep skip that baseline
 * *forever* against a doc that never had it, and the note keeps a stale body
 * with nothing left to correct it (#1613, FM2).
 *
 * So the location is not an implementation detail, it is the whole design:
 *
 *  - it is a **y-leveldb doc meta key**, which puts it in the same LevelDB, in
 *    the same directory, behind the same handle as the note's updates. There is
 *    no way to read it without the store that holds the document;
 *  - `LeveldbPersistence.clearDocument(noteId)` clears the key range
 *    `['v1', noteId] … ['v1', noteId, 'zzzzzzz']`, and a meta key is
 *    `['v1', noteId, 'meta', …]` — inside it. So `CrdtProvider.purge()` and the
 *    legacy-store partition drop each document's watermark **in the same
 *    operation** that drops the document;
 *  - quarantine (`crdt-persistence.ts` moves the whole directory aside), a
 *    rebuild (LevelDB recreates an empty directory) and a re-path
 *    (`settlePendingCrdtStoreRename` renames the directory) all move or destroy
 *    the watermarks with the documents, because they are the same bytes;
 *  - a store that could not be opened at all degrades the provider to in-memory
 *    mode with `persistence === null`, and then there is no handle to read a
 *    watermark through either.
 *
 * It must NOT live in the index DB, in `store` (electron-store), or anywhere
 * else with an independent lifetime. Losing a watermark costs one extra GET;
 * keeping a stale one costs a note body.
 *
 * Compat: this key is additive and invisible to any build that does not read it.
 * A store written by an older build simply has no such key, which decodes to
 * `null` — unknown, therefore fetch, never "sequence 0, therefore skip". A newer
 * store read by an older build is equally harmless: the older build never asks
 * for the key, and `clearDocument` still sweeps it away with the document.
 */

/** Where a note's merge got to, as far as the *store* is concerned. */
export interface CrdtSnapshotWatermark {
  /** Highest `crdt_updates.sequence_num` applied to this note's document. */
  appliedSequence: number
  /**
   * `revision` of the server snapshot blob actually decrypted into the document.
   *
   * Optional because an older server does not publish one. Absent means the
   * snapshot half of the watermark is unknown, which the skip rule reads as
   * "cannot match" — the note falls through to a fetch.
   */
  snapshotRevision?: string
}

/**
 * The meta key, versioned so a future shape change is a new key rather than a
 * reinterpretation of bytes an older build wrote.
 */
export const SNAPSHOT_WATERMARK_META_KEY = 'memry.snapshotWatermark.v1'

/** The slice of the store this module needs. */
export interface WatermarkMetaStore {
  getMeta(docName: string, metaKey: string): Promise<unknown>
  setMeta(docName: string, metaKey: string, value: unknown): Promise<void>
}

/**
 * Parse whatever came back out of the store.
 *
 * Every rejection returns `null`, and `null` means *unknown* — which the caller
 * must answer with a fetch. There is deliberately no default: a malformed or
 * truncated record read as `{ appliedSequence: 0 }` would be a licence to skip
 * a baseline on the strength of a record nobody wrote.
 */
export function decodeSnapshotWatermark(raw: unknown): CrdtSnapshotWatermark | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const appliedSequence = record.appliedSequence
  if (typeof appliedSequence !== 'number' || !Number.isFinite(appliedSequence)) return null
  if (appliedSequence < 0) return null
  const snapshotRevision = record.snapshotRevision
  if (snapshotRevision !== undefined && typeof snapshotRevision !== 'string') return null
  return snapshotRevision ? { appliedSequence, snapshotRevision } : { appliedSequence }
}

/**
 * Read a note's watermark out of the store, or `null` when there is not one this
 * code is willing to act on — no key, an unreadable store, or a record that does
 * not decode.
 */
export async function readSnapshotWatermark(
  store: WatermarkMetaStore,
  noteId: string
): Promise<CrdtSnapshotWatermark | null> {
  const raw = await store.getMeta(noteId, SNAPSHOT_WATERMARK_META_KEY)
  return decodeSnapshotWatermark(raw)
}

/**
 * Record a note's watermark in the store.
 *
 * `snapshotRevision` is written as absent rather than as `undefined` when there
 * is none, so a note whose revision was dropped (an older server on the snapshot
 * endpoint) reads back as "sequence known, snapshot unknown" and its next skip
 * decision falls through to a fetch instead of matching a token nobody holds.
 */
export async function writeSnapshotWatermark(
  store: WatermarkMetaStore,
  noteId: string,
  watermark: CrdtSnapshotWatermark
): Promise<void> {
  const value: CrdtSnapshotWatermark = watermark.snapshotRevision
    ? { appliedSequence: watermark.appliedSequence, snapshotRevision: watermark.snapshotRevision }
    : { appliedSequence: watermark.appliedSequence }
  await store.setMeta(noteId, SNAPSHOT_WATERMARK_META_KEY, value)
}
