import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

const mocks = vi.hoisted(() => ({
  userDataDir: '/userData',
  dataDb: {} as object | null,
  vaultUuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  vaultCount: 1,
  claim: undefined as string | undefined,
  partitionPending: undefined as string | undefined,
  openStore: null as ((storagePath: string) => Promise<unknown>) | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.dataDb,
  isDatabaseInitialized: () => mocks.dataDb !== null
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: () => mocks.vaultUuid
}))

vi.mock('../store', () => ({
  getVaults: () => Array.from({ length: mocks.vaultCount }, (_, i) => ({ path: `/vault-${i}` })),
  getLegacyCrdtStoreClaim: () => mocks.claim,
  recordLegacyCrdtStoreClaim: (vaultUuid: string, options?: { partitionPending?: boolean }) => {
    mocks.claim = vaultUuid
    if (options?.partitionPending) mocks.partitionPending = vaultUuid
  },
  getLegacyCrdtStorePartitionPending: () => mocks.partitionPending,
  clearLegacyCrdtStorePartitionPending: () => {
    mocks.partitionPending = undefined
  }
}))

// The real one forks a preflight child through electron's utilityProcess, which
// does not exist under vitest. The store it hands back is a real y-leveldb one,
// so the migration below runs against real on-disk CRDT documents.
vi.mock('./crdt-persistence', () => ({
  openCrdtPersistence: (storagePath: string) =>
    mocks.openStore
      ? mocks.openStore(storagePath)
      : Promise.resolve(new LeveldbPersistence(storagePath))
}))

import { prepareVaultCrdtStore, resolveVaultCrdtStore } from './crdt-store-path'
import { UNATTRIBUTABLE_DOC_PREFIX } from './crdt-legacy-partition'

describe('vault CRDT store path', () => {
  beforeEach(() => {
    mocks.userDataDir = '/userData'
    mocks.dataDb = {}
    mocks.vaultUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  })

  it('names the directory after the vault uuid', () => {
    expect(resolveVaultCrdtStore()).toEqual({
      vaultUuid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      storagePath: '/userData/crdt-stores/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    })
  })

  it('resolves one directory for a uuid whichever case it comes back in', () => {
    // A linked device adopts the SERVER's uuid, so the casing is not ours to
    // assume. macOS and Windows filesystems are case-insensitive: two casings
    // resolving to two paths would mean one vault with two half-histories.
    mocks.vaultUuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'.toUpperCase()
    expect(resolveVaultCrdtStore()?.storagePath).toBe(
      '/userData/crdt-stores/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    )
  })

  it('hashes an identifier that is not a plain uuid instead of putting it in a path', () => {
    // Nothing local mints this shape, but the value is adopted from the server,
    // and a separator in it would resolve somewhere else entirely.
    mocks.vaultUuid = '../../../etc'
    const storagePath = resolveVaultCrdtStore()?.storagePath ?? ''

    expect(storagePath.startsWith('/userData/crdt-stores/')).toBe(true)
    expect(storagePath).not.toContain('..')
    expect(storagePath).toMatch(/\/crdt-stores\/[0-9a-f]{32}$/)
  })

  it('has no path to resolve while no vault is open', () => {
    mocks.dataDb = null
    expect(resolveVaultCrdtStore()).toBeNull()
  })
})

describe('inheriting the legacy global CRDT store', () => {
  const VAULT_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
  const JOURNAL_ID = 'j2026-08-13'
  const NOTE_ID = 'abcdefabcdef'

  let userData: string

  const legacyPath = (): string => path.join(userData, 'crdt-store')
  const vaultStorePath = (vaultUuid = VAULT_A): string =>
    path.join(userData, 'crdt-stores', vaultUuid)

  async function withStore<T>(dir: string, fn: (store: LeveldbPersistence) => Promise<T>) {
    const store = new LeveldbPersistence(dir)
    try {
      return await fn(store)
    } finally {
      await store.destroy()
    }
  }

  async function writeDoc(dir: string, docName: string, text: string): Promise<void> {
    await withStore(dir, async (store) => {
      const doc = new Y.Doc()
      doc.getText('body').insert(0, text)
      await store.storeUpdate(docName, Y.encodeStateAsUpdate(doc))
      doc.destroy()
    })
  }

  async function readDoc(dir: string, docName: string): Promise<string> {
    return await withStore(dir, async (store) => {
      const doc = await store.getYDoc(docName)
      const text = doc.getText('body').toString()
      doc.destroy()
      return text
    })
  }

  beforeEach(async () => {
    userData = mkdtempSync(path.join(tmpdir(), 'memry-crdt-store-path-'))
    mocks.userDataDir = userData
    mocks.dataDb = {}
    mocks.vaultUuid = VAULT_A
    mocks.vaultCount = 1
    mocks.claim = undefined
    mocks.partitionPending = undefined
    mocks.openStore = null

    // One store, keyed by note id, written by every vault on this install: the
    // day's journal id is the same string in both vaults, the note id is not.
    await writeDoc(legacyPath(), JOURNAL_ID, 'the other vault’s journal')
    await writeDoc(legacyPath(), NOTE_ID, 'this vault’s note')
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('does not let another vault’s journal attach to this vault’s journal id', async () => {
    // The reported scenario: two vaults on one install, a colliding
    // deterministic journal id, and the first vault to open inheriting it.
    mocks.vaultCount = 2

    await prepareVaultCrdtStore()

    expect(await readDoc(vaultStorePath(), JOURNAL_ID)).toBe('')
    // An empty document is what makes the provider seed the note from this
    // vault's own markdown, which is the whole point of clearing it.
    expect(await readDoc(vaultStorePath(), NOTE_ID)).toBe('this vault’s note')
  })

  it('keeps the ambiguous history on disk rather than deleting it', async () => {
    mocks.vaultCount = 2

    await prepareVaultCrdtStore()

    expect(await readDoc(vaultStorePath(), `${UNATTRIBUTABLE_DOC_PREFIX}${JOURNAL_ID}`)).toBe(
      'the other vault’s journal'
    )
  })

  it('inherits the store whole when this install has only ever had one vault', async () => {
    // Nothing can be ambiguous without a second vault, and journal history is
    // not something to throw away from the install that owns all of it.
    mocks.vaultCount = 1

    await prepareVaultCrdtStore()

    expect(await readDoc(vaultStorePath(), JOURNAL_ID)).toBe('the other vault’s journal')
    expect(mocks.partitionPending).toBeUndefined()
  })

  it('partitions on the next launch when the move landed but the pass did not', async () => {
    // Crash-safety: the record is written with the claim, before the move, and
    // it — not the legacy directory — is what drives the pass. Simulate the
    // interrupted launch by moving the store by hand and leaving it pending.
    mocks.vaultCount = 2
    mocks.claim = VAULT_A
    mocks.partitionPending = VAULT_A
    await writeDoc(vaultStorePath(), JOURNAL_ID, 'the other vault’s journal')
    rmSync(legacyPath(), { recursive: true, force: true })

    await prepareVaultCrdtStore()

    expect(await readDoc(vaultStorePath(), JOURNAL_ID)).toBe('')
    expect(mocks.partitionPending).toBeUndefined()
  })

  it('stays pending when the pass could not run', async () => {
    mocks.vaultCount = 2
    mocks.openStore = () => Promise.resolve(null)

    await prepareVaultCrdtStore()

    expect(mocks.partitionPending).toBe(VAULT_A)
  })

  it('does not touch the store of a vault that owes no partition', async () => {
    // The pass is reached on every vault open, so the record it reads is the
    // only thing keeping it off stores it was never asked about — including
    // this vault's own journal, which is not the migration's to clear.
    mocks.vaultCount = 2
    mocks.claim = 'some-other-vault-uuid'
    mocks.partitionPending = 'some-other-vault-uuid'
    await writeDoc(vaultStorePath(), JOURNAL_ID, 'this vault’s own journal')

    await prepareVaultCrdtStore()

    expect(await readDoc(vaultStorePath(), JOURNAL_ID)).toBe('this vault’s own journal')
    // And the legacy store is still whole, waiting for the vault that claimed it.
    expect(await readDoc(legacyPath(), JOURNAL_ID)).toBe('the other vault’s journal')
  })
})
