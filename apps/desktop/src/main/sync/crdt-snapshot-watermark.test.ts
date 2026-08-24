/**
 * The durable half of FM2 (#1613), against a REAL y-leveldb store.
 *
 * The claim this file has to hold up is not "the watermark round-trips" — it is
 * **"the store is gone" implies "the watermark is gone"**. A watermark that
 * survives its store makes the sweep skip a snapshot baseline forever against a
 * document that never had it, and the note keeps a stale body with nothing left
 * to correct it. So every assertion here is about a store that was quarantined,
 * rebuilt or re-pathed, and every one of them uses the same on-disk semantics
 * the product does: a real LevelDB, a real directory rename.
 *
 * Nothing is mocked. A mocked store agreeing with a mocked reader is exactly the
 * green-tests-over-broken-behaviour failure this subsystem is known for (#1499).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { moveStoreDir } from './crdt-store-move'
import {
  SNAPSHOT_WATERMARK_META_KEY,
  decodeSnapshotWatermark,
  readSnapshotWatermark,
  writeSnapshotWatermark
} from '@memry/sync-client/crdt-snapshot-watermark'

let root: string
let storeDir: string

const NOTE = 'note-1'

async function withStore<T>(
  dir: string,
  fn: (store: LeveldbPersistence) => Promise<T>
): Promise<T> {
  const store = new LeveldbPersistence(dir)
  try {
    return await fn(store)
  } finally {
    await store.destroy()
  }
}

/** A note with real CRDT history AND a watermark describing it. */
async function seedMergedNote(dir: string, appliedSequence: number): Promise<void> {
  await withStore(dir, async (store) => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'remote body')
    await store.storeUpdate(NOTE, Y.encodeStateAsUpdate(doc))
    doc.destroy()
    await writeSnapshotWatermark(store, NOTE, { appliedSequence, snapshotRevision: 'rev-1' })
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'memry-watermark-'))
  storeDir = path.join(root, 'crdt-stores', 'vault-a')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the persisted CRDT snapshot watermark', () => {
  it('round-trips through the store the document lives in', async () => {
    await seedMergedNote(storeDir, 42)

    const read = await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))
    expect(read).toEqual({ appliedSequence: 42, snapshotRevision: 'rev-1' })
  })

  it('is stored inside the document key range, so clearDocument takes it', async () => {
    await seedMergedNote(storeDir, 42)

    await withStore(storeDir, async (store) => {
      // What `CrdtProvider.purge()` and the legacy-store partition call. It is
      // not given the meta key and does not know one exists — the guarantee is
      // that a meta key is `['v1', noteId, 'meta', …]`, inside the range
      // `['v1', noteId] … ['v1', noteId, 'zzzzzzz']` that this clears.
      await store.clearDocument(NOTE)
    })

    const read = await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))
    expect(read).toBeNull()
  })

  // THE MERGE GATE. Removing the watermark drop from the store-teardown path has
  // to redden this.
  it('is quarantined with the store, so a rebuilt store starts with no watermarks', async () => {
    await seedMergedNote(storeDir, 42)

    // Exactly what `settleStoreStageFailure` does when the preflight implicates
    // the store's own data: move the whole directory aside. LevelDB then
    // recreates the leaf, vault markdown reseeds the notes, and the CRDT history
    // is gone — so the watermark describing that history must be gone too.
    const quarantinePath = `${storeDir}.broken-1`
    expect(await moveStoreDir(storeDir, quarantinePath)).toBe(true)
    expect(existsSync(storeDir)).toBe(false)

    const rebuilt = await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))
    expect(rebuilt).toBeNull()

    // And the rebuilt store has no document either — the two vanished in the
    // same operation, which is the property, not a coincidence of ordering.
    const body = await withStore(storeDir, async (store) => {
      const doc = await store.getYDoc(NOTE)
      const text = doc.getText('body').toString()
      doc.destroy()
      return text
    })
    expect(body).toBe('')
  })

  it('travels with the store when the vault re-paths it, never apart from it', async () => {
    await seedMergedNote(storeDir, 42)

    // `settlePendingCrdtStoreRename`: the vault adopted a new uuid, so the store
    // directory follows it. The documents move, so the watermarks must move with
    // them — and the old path must hold neither.
    const adoptedPath = path.join(root, 'crdt-stores', 'vault-b')
    expect(await moveStoreDir(storeDir, adoptedPath)).toBe(true)

    expect(await withStore(adoptedPath, (store) => readSnapshotWatermark(store, NOTE))).toEqual({
      appliedSequence: 42,
      snapshotRevision: 'rev-1'
    })
    // The pre-adoption path is now a fresh, empty store: no document, and
    // therefore no watermark to skip a baseline on.
    expect(await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))).toBeNull()
  })

  it('is not readable across vaults: each vault store answers only for itself', async () => {
    await seedMergedNote(storeDir, 42)

    const otherVault = path.join(root, 'crdt-stores', 'vault-b')
    expect(await withStore(otherVault, (store) => readSnapshotWatermark(store, NOTE))).toBeNull()
  })

  it('reads a store written by an older build as unknown, never as sequence 0', async () => {
    // An older build stored the document and nothing else — no meta key ever
    // existed. Absent must stay absent all the way up: `null` is what
    // `snapshotBaselineSkip` needs to fall through to a fetch, and
    // `{ appliedSequence: 0 }` would be a licence to skip.
    await withStore(storeDir, async (store) => {
      const doc = new Y.Doc()
      doc.getText('body').insert(0, 'written by an older build')
      await store.storeUpdate(NOTE, Y.encodeStateAsUpdate(doc))
      doc.destroy()
    })

    expect(await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))).toBeNull()
  })

  it('drops the revision rather than keeping a stale one when there is none', async () => {
    await seedMergedNote(storeDir, 42)
    await withStore(storeDir, (store) =>
      writeSnapshotWatermark(store, NOTE, { appliedSequence: 50 })
    )

    // Sequence known, snapshot unknown — which the skip rule cannot match, so
    // the note fetches its baseline rather than trusting a token nobody holds.
    expect(await withStore(storeDir, (store) => readSnapshotWatermark(store, NOTE))).toEqual({
      appliedSequence: 50
    })
  })

  it('leaves a downgrade harmless: an older build reads the document and ignores the key', async () => {
    await seedMergedNote(storeDir, 42)

    // "An older build" is a reader that only ever asks for documents. The key is
    // additive and namespaced, so it cannot collide with one, and the document
    // it sits beside is unchanged.
    const body = await withStore(storeDir, async (store) => {
      const doc = await store.getYDoc(NOTE)
      const text = doc.getText('body').toString()
      doc.destroy()
      return text
    })
    expect(body).toBe('remote body')
    expect(SNAPSHOT_WATERMARK_META_KEY).toBe('memry.snapshotWatermark.v1')
  })

  it.each([
    ['no record', undefined],
    ['null', null],
    ['a bare number', 7],
    ['a string', 'rev-1'],
    ['no sequence', { snapshotRevision: 'rev-1' }],
    ['a non-numeric sequence', { appliedSequence: '42', snapshotRevision: 'rev-1' }],
    ['NaN', { appliedSequence: Number.NaN }],
    ['a negative sequence', { appliedSequence: -1 }],
    ['a non-string revision', { appliedSequence: 42, snapshotRevision: 7 }]
  ])('decodes %s as unknown, so the caller fetches', (_label, raw) => {
    expect(decodeSnapshotWatermark(raw)).toBeNull()
  })
})
