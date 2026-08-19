import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'

import * as schema from '@memry/db-schema/data-schema'
import { VAULT_KEY_VERIFIER_SETTING } from '../crypto/vault-key-state'

const mocks = vi.hoisted(() => ({
  dataDb: null as object | null,
  userData: '/userData'
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? mocks.userData : `/mock/${name}`) }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

// The real module pulls the telemetry runtime, whose electron import ('net')
// the mock above does not provide.
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.dataDb,
  isDatabaseInitialized: () => mocks.dataDb !== null
}))

// The real one forks a preflight child through electron's utilityProcess, which
// does not exist under vitest. The store it hands back is a real y-leveldb one,
// so the assertions below run against real on-disk CRDT documents.
vi.mock('./crdt-persistence', () => ({
  openCrdtPersistence: (storagePath: string) => Promise.resolve(new LeveldbPersistence(storagePath))
}))

function createTestDataDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      modified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE vault_metadata (
      id TEXT PRIMARY KEY,
      vault_uuid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return drizzle(sqlite, { schema })
}

const INITIATOR_UUID = '8945f5fd-0e05-45f5-bae5-2979737aa0d0'

describe('adoptVaultLocally', () => {
  let db: ReturnType<typeof createTestDataDb>
  let userData: string

  // Re-imported per test: `store.ts` caches the config file in a module-level
  // variable, and every test gets its own userData directory.
  let adoptVaultLocally: typeof import('./vault-adoption').adoptVaultLocally
  let getOrCreateVaultUuid: typeof import('../agent/storage/vault-id').getOrCreateVaultUuid
  let resetVaultUuidCache: typeof import('../agent/storage/vault-id').resetVaultUuidCache
  let getPendingCrdtStoreRename: typeof import('../store').getPendingCrdtStoreRename
  let recordLegacyCrdtStoreClaim: typeof import('../store').recordLegacyCrdtStoreClaim
  let getLegacyCrdtStoreClaim: typeof import('../store').getLegacyCrdtStoreClaim
  let getLegacyCrdtStorePartitionPending: typeof import('../store').getLegacyCrdtStorePartitionPending
  let prepareVaultCrdtStore: typeof import('./crdt-store-path').prepareVaultCrdtStore

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(path.join(tmpdir(), 'memry-vault-adoption-'))
    mocks.userData = userData
    db = createTestDataDb()
    mocks.dataDb = db

    ;({ adoptVaultLocally } = await import('./vault-adoption'))
    ;({ getOrCreateVaultUuid, resetVaultUuidCache } = await import('../agent/storage/vault-id'))
    ;({
      getPendingCrdtStoreRename,
      recordLegacyCrdtStoreClaim,
      getLegacyCrdtStoreClaim,
      getLegacyCrdtStorePartitionPending
    } = await import('../store'))
    ;({ prepareVaultCrdtStore } = await import('./crdt-store-path'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  const storePath = (vaultUuid: string): string => path.join(userData, 'crdt-stores', vaultUuid)

  async function writeDoc(dir: string, docName: string, text: string): Promise<void> {
    const store = new LeveldbPersistence(dir)
    const doc = new Y.Doc()
    doc.getText('body').insert(0, text)
    await store.storeUpdate(docName, Y.encodeStateAsUpdate(doc))
    doc.destroy()
    await store.destroy()
  }

  async function readDoc(dir: string, docName: string): Promise<string> {
    const store = new LeveldbPersistence(dir)
    const doc = await store.getYDoc(docName)
    const text = doc.getText('body').toString()
    doc.destroy()
    await store.destroy()
    return text
  }

  it('binds the joiner to the initiator vault uuid instead of a fresh one', () => {
    // Joiner opened a fresh local vault first → its own random uuid + a stale
    // verifier. This first call also primes the handle-keyed cache inside
    // getOrCreateVaultUuid — keep it: without adoptVaultLocally's explicit
    // invalidation, every later call site would still read the joiner's own id
    // and register the device against the wrong vault.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    db.insert(schema.settings)
      .values({ key: VAULT_KEY_VERIFIER_SETTING, value: 'stale-verifier' })
      .run()
    expect(joinerOwnUuid).not.toBe(INITIATOR_UUID)

    adoptVaultLocally(db, INITIATOR_UUID)

    // vault_metadata now holds the initiator's uuid → registration will send V.
    expect(getOrCreateVaultUuid(db)).toBe(INITIATOR_UUID)
    // and it stays adopted once re-cached, rather than flapping per call.
    expect(getOrCreateVaultUuid(db)).toBe(INITIATOR_UUID)
    // stale verifier cleared so bindLocalVaultToMasterKey can rebind cleanly.
    const verifier = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, VAULT_KEY_VERIFIER_SETTING))
      .get()
    expect(verifier).toBeUndefined()
  })

  it('records where this vault’s CRDT store is, under the uuid it is moving to', () => {
    const joinerOwnUuid = getOrCreateVaultUuid(db)

    adoptVaultLocally(db, INITIATOR_UUID)

    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBe(joinerOwnUuid)
  })

  it('records nothing for a vault that has never had a uuid', () => {
    // `createDormantVault` adopts into a data.db it has just created, before
    // anything asks for its identity — there is no store to follow it, and
    // minting a predecessor here would invent one.
    adoptVaultLocally(db, INITIATOR_UUID)

    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBeUndefined()
  })

  it('records nothing when the vault already holds the adopted uuid', () => {
    // The multi-vault linking flow adopts into the primary vault twice:
    // `createDormantVault` first, then `finalizeLinking` once it is open.
    adoptVaultLocally(db, INITIATOR_UUID)
    resetVaultUuidCache()

    adoptVaultLocally(db, INITIATOR_UUID)

    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBeUndefined()
  })

  it('records the store’s whereabouts before the uuid it depends on is rewritten', () => {
    // Crash safety: recorded-but-not-rewritten is inert and re-recorded
    // identically when the link is retried; rewritten-but-not-recorded is the
    // orphan this exists to prevent. Standing in for the crash: a rewrite that
    // throws, because the settings table this vault's db does not have.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    db.run('DROP TABLE settings')

    expect(() => adoptVaultLocally(db, INITIATOR_UUID)).toThrow()

    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBe(joinerOwnUuid)
  })

  it('still points at the directory it wrote after adopting twice in a row', () => {
    // Link, unlink, relink without the store being opened in between. The middle
    // uuid never named a directory, so a record pointing at it would move
    // nothing and the history would be orphaned exactly as before.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    const OTHER_ACCOUNT_UUID = 'c0ffee00-dead-4bee-8fed-0123456789ab'

    adoptVaultLocally(db, INITIATOR_UUID)
    resetVaultUuidCache()
    adoptVaultLocally(db, OTHER_ACCOUNT_UUID)

    expect(getPendingCrdtStoreRename(OTHER_ACCOUNT_UUID)).toBe(joinerOwnUuid)
    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBeUndefined()
  })

  it('cancels the rename when the vault adopts its way back to its own uuid', () => {
    const joinerOwnUuid = getOrCreateVaultUuid(db)

    adoptVaultLocally(db, INITIATOR_UUID)
    resetVaultUuidCache()
    adoptVaultLocally(db, joinerOwnUuid)

    expect(getPendingCrdtStoreRename(joinerOwnUuid)).toBeUndefined()
    expect(getPendingCrdtStoreRename(INITIATOR_UUID)).toBeUndefined()
  })

  it('carries the legacy-store claim and its unfinished partition to the new uuid', () => {
    // Both name a vault by uuid, and that uuid is exactly what is changing. Left
    // behind they would name nobody: the legacy store could never be inherited
    // and its ambiguous documents could never be set aside.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    recordLegacyCrdtStoreClaim(joinerOwnUuid, { partitionPending: true })

    adoptVaultLocally(db, INITIATOR_UUID)

    expect(getLegacyCrdtStoreClaim()).toBe(INITIATOR_UUID)
    expect(getLegacyCrdtStorePartitionPending()).toBe(INITIATOR_UUID)
  })

  it('still has the pre-link history after the device links and restarts', async () => {
    // The reported scenario, end to end and on real disk: the joiner opens its
    // own vault and writes CRDT history, links (which rewrites the uuid the
    // store is named after), and the next launch must reach that history rather
    // than open an empty store and re-seed every note from markdown.
    const joinerOwnUuid = getOrCreateVaultUuid(db)
    const beforeLinking = await prepareVaultCrdtStore()
    expect(beforeLinking?.storagePath).toBe(storePath(joinerOwnUuid))
    await writeDoc(beforeLinking!.storagePath, 'abcdefabcdef', 'written before linking')

    adoptVaultLocally(db, INITIATOR_UUID)

    // Restart: the store is closed and the path resolved again from scratch.
    resetVaultUuidCache()
    const afterRestart = await prepareVaultCrdtStore()

    expect(afterRestart?.storagePath).toBe(storePath(INITIATOR_UUID))
    expect(await readDoc(afterRestart!.storagePath, 'abcdefabcdef')).toBe('written before linking')
    expect(existsSync(storePath(joinerOwnUuid))).toBe(false)
  })
})
