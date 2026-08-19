import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

const mocks = vi.hoisted(() => ({
  openStore: null as ((storagePath: string) => Promise<unknown>) | null
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

// The real one forks a preflight child through electron's utilityProcess, which
// does not exist under vitest. Everything below it — enumeration, the archive
// write, the clear — runs against a REAL y-leveldb store, because those are the
// exact semantics this module is betting on.
vi.mock('./crdt-persistence', () => ({
  openCrdtPersistence: (storagePath: string) =>
    mocks.openStore
      ? mocks.openStore(storagePath)
      : Promise.resolve(new LeveldbPersistence(storagePath))
}))

import {
  UNATTRIBUTABLE_DOC_PREFIX,
  isCrossVaultAmbiguousDocId,
  setAsideAmbiguousLegacyDocs
} from './crdt-legacy-partition'

let storeDir: string

async function withStore<T>(fn: (store: LeveldbPersistence) => Promise<T>): Promise<T> {
  const store = new LeveldbPersistence(storeDir)
  try {
    return await fn(store)
  } finally {
    await store.destroy()
  }
}

async function writeDoc(docName: string, text: string): Promise<void> {
  await withStore(async (store) => {
    const doc = new Y.Doc()
    doc.getText('body').insert(0, text)
    await store.storeUpdate(docName, Y.encodeStateAsUpdate(doc))
    doc.destroy()
  })
}

async function readDoc(docName: string): Promise<string> {
  return await withStore(async (store) => {
    const doc = await store.getYDoc(docName)
    const text = doc.getText('body').toString()
    doc.destroy()
    return text
  })
}

beforeEach(() => {
  mocks.openStore = null
  storeDir = mkdtempSync(path.join(tmpdir(), 'memry-crdt-partition-'))
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('cross-vault ambiguous document ids', () => {
  it('treats a deterministic journal id as ambiguous and a random note id as not', () => {
    expect(isCrossVaultAmbiguousDocId('j2026-08-13')).toBe(true)
    expect(isCrossVaultAmbiguousDocId('abcdefabcdef')).toBe(false)
    // Already set aside: re-running the pass must not archive the archive.
    expect(isCrossVaultAmbiguousDocId(`${UNATTRIBUTABLE_DOC_PREFIX}j2026-08-13`)).toBe(false)
  })
})

describe('setting aside inherited documents two vaults could both have written', () => {
  it('stops the other vault’s journal from attaching, and keeps every random id', async () => {
    // The reported scenario. One global store, two vaults: the day's journal id
    // is the same string in both, so this document is not the inheriting
    // vault's to load. The random note id is.
    await writeDoc('j2026-08-13', 'the other vault’s journal')
    await writeDoc('abcdefabcdef', 'this vault’s note')

    expect(await setAsideAmbiguousLegacyDocs(storeDir)).toBe(true)

    expect(await readDoc('j2026-08-13')).toBe('')
    expect(await readDoc('abcdefabcdef')).toBe('this vault’s note')
  })

  it('sets the ambiguous history aside instead of deleting it', async () => {
    await writeDoc('j2026-08-13', 'the other vault’s journal')

    await setAsideAmbiguousLegacyDocs(storeDir)

    const names = await withStore((store) => store.getAllDocNames())
    expect(names).toContain(`${UNATTRIBUTABLE_DOC_PREFIX}j2026-08-13`)
    expect(await readDoc(`${UNATTRIBUTABLE_DOC_PREFIX}j2026-08-13`)).toBe(
      'the other vault’s journal'
    )
  })

  it('is safe to run again after being interrupted', async () => {
    // Crash-safety rests on this: an incomplete pass leaves the record pending
    // and the next launch simply repeats it.
    await writeDoc('j2026-08-13', 'the other vault’s journal')

    expect(await setAsideAmbiguousLegacyDocs(storeDir)).toBe(true)
    expect(await setAsideAmbiguousLegacyDocs(storeDir)).toBe(true)

    expect(await readDoc('j2026-08-13')).toBe('')
    expect(await readDoc(`${UNATTRIBUTABLE_DOC_PREFIX}j2026-08-13`)).toBe(
      'the other vault’s journal'
    )
  })

  it('reports a store it could not open rather than claiming the pass is done', async () => {
    mocks.openStore = () => Promise.resolve(null)
    expect(await setAsideAmbiguousLegacyDocs(storeDir)).toBe(false)
  })

  it('releases the store so the provider can open it straight after', async () => {
    await writeDoc('j2026-08-13', 'the other vault’s journal')
    await setAsideAmbiguousLegacyDocs(storeDir)

    // LevelDB holds an exclusive LOCK. y-leveldb swallows a failed transaction
    // into a null result rather than rejecting, so this has to assert a real
    // read came back, not merely that the promise settled.
    const names = await withStore((store) => store.getAllDocNames())
    expect(names).toEqual([`${UNATTRIBUTABLE_DOC_PREFIX}j2026-08-13`])
  })
})
