import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { runIndexMigrations } from './migrate'
import {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase,
  closeAllDatabases,
  checkIndexHealth,
  withTimeout,
  SQLITE_DATA_CACHE_KIB,
  SQLITE_INDEX_CACHE_KIB
} from './client'

describe('database client', () => {
  let tempDir: string
  let dataDbPath: string
  let indexDbPath: string

  beforeEach(() => {
    loggerWarnMock.mockClear()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-db-client-'))
    dataDbPath = path.join(tempDir, 'data.db')
    indexDbPath = path.join(tempDir, 'index.db')
  })

  afterEach(() => {
    closeAllDatabases()
    vi.useRealTimers()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('initializes the data database with expected pragmas', () => {
    const db = initDatabase(dataDbPath)
    expect(getDatabase()).toBe(db)

    const client = (db as unknown as { $client: Database.Database }).$client
    expect(String(client.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(client.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(client.pragma('synchronous', { simple: true })).toBe(1)
    expect(client.pragma('cache_size', { simple: true })).toBe(-SQLITE_DATA_CACHE_KIB)
    expect(client.pragma('temp_store', { simple: true })).toBe(2)
  })

  it('registers ulower on the data connection the running app uses', () => {
    // #given — the real app data connection, not the test-db helper. Calendar
    // title search calls ulower() through requireDatabase(), so a fix proven
    // only against createTestDataDb would still be broken in the app.
    const db = initDatabase(dataDbPath)
    const client = (db as unknown as { $client: Database.Database }).$client

    // #when — we fold non-ASCII text the way the calendar query does
    const folded = client
      .prepare('SELECT ulower(?) AS turkish, ulower(?) AS german, ulower(?) AS cyrillic')
      .get('Ödeme Toplantısı', 'MÜNCHEN', 'ЛЕКЦИЯ') as Record<string, string>

    // #then — full Unicode folding, which SQLite's built-in lower() does not do
    expect(folded.turkish).toBe('ödeme toplantısı')
    expect(folded.german).toBe('münchen')
    expect(folded.cyrillic).toBe('лекция')

    // #then — non-string inputs pass through untouched
    const passthrough = client.prepare('SELECT ulower(NULL) AS a, ulower(7) AS b').get() as Record<
      string,
      unknown
    >
    expect(passthrough.a).toBeNull()
    expect(passthrough.b).toBe(7)
  })

  it('initializes the index database with vec table and cache settings', () => {
    const db = initIndexDatabase(indexDbPath)
    expect(getIndexDatabase()).toBe(db)

    const raw = getRawIndexDatabase()
    const vecTable = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_notes'")
      .get() as { name?: string } | undefined

    expect(vecTable?.name).toBe('vec_notes')
    expect(String(raw.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(raw.pragma('cache_size', { simple: true })).toBe(-SQLITE_INDEX_CACHE_KIB)
    expect(raw.pragma('temp_store', { simple: true })).toBe(2)
  })

  it('closes the previous data handle when initDatabase runs again', () => {
    // #given — a connection left behind by an open that threw after
    // initDatabase, so closeVault() early-returned and never closed it
    const orphan = initDatabase(dataDbPath)
    const orphanClient = (orphan as unknown as { $client: Database.Database }).$client
    expect(orphanClient.open).toBe(true)

    // #when — the retry re-enters initDatabase on top of that orphan
    const live = initDatabase(dataDbPath)
    const liveClient = (live as unknown as { $client: Database.Database }).$client

    // #then — the orphan (16MB page cache + fd + WAL) is gone, one live handle left
    expect(orphanClient.open).toBe(false)
    expect(liveClient).not.toBe(orphanClient)
    expect(liveClient.open).toBe(true)
    expect(getDatabase()).toBe(live)
  })

  it('closes the previous index handle when initIndexDatabase runs again', () => {
    // #given — an index connection from a vault open that never reached close
    initIndexDatabase(indexDbPath)
    const orphanRaw = getRawIndexDatabase()
    expect(orphanRaw.open).toBe(true)

    // #when — the retry re-enters initIndexDatabase on top of that orphan
    const live = initIndexDatabase(indexDbPath)
    const liveRaw = getRawIndexDatabase()

    // #then — the orphan (32MB page cache + fd + WAL) is gone, one live handle left
    expect(orphanRaw.open).toBe(false)
    expect(liveRaw).not.toBe(orphanRaw)
    expect(liveRaw.open).toBe(true)
    expect(getIndexDatabase()).toBe(live)
  })

  it('leaks rather than fails the open when the previous data handle refuses to close', () => {
    // #given — a stale connection whose close() throws, the way better-sqlite3
    // rejects a close on a busy connection
    const orphan = initDatabase(dataDbPath)
    const orphanClient = (orphan as unknown as { $client: Database.Database }).$client
    const refusingClose = vi.spyOn(orphanClient, 'close').mockImplementation(() => {
      throw new Error('database is busy')
    })

    // #when — the retry re-enters initDatabase on top of it
    const live = initDatabase(dataDbPath)
    const liveClient = (live as unknown as { $client: Database.Database }).$client

    // #then — the refusal degrades to a leak, never to a failed vault open
    expect(liveClient).not.toBe(orphanClient)
    expect(liveClient.open).toBe(true)
    expect(liveClient.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 })

    // #then — post-init state is coherent: the getter resolves the new handle,
    // never the stale one closeDatabase() left behind when its close() threw
    expect(getDatabase()).toBe(live)
    expect((getDatabase() as unknown as { $client: Database.Database }).$client).toBe(liveClient)

    // #then — the returning leak is visible in the diagnostic logs
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('previous data connection'),
      expect.any(Error)
    )

    refusingClose.mockRestore()
    orphanClient.close()
  })

  it('leaks rather than fails the open when the previous index handle refuses to close', () => {
    // #given — a stale index connection whose close() throws
    initIndexDatabase(indexDbPath)
    const orphanRaw = getRawIndexDatabase()
    const refusingClose = vi.spyOn(orphanRaw, 'close').mockImplementation(() => {
      throw new Error('database is busy')
    })

    // #when — the retry re-enters initIndexDatabase on top of it
    const live = initIndexDatabase(indexDbPath)
    const liveRaw = getRawIndexDatabase()

    // #then — the refusal degrades to a leak, never to a failed vault open
    expect(liveRaw).not.toBe(orphanRaw)
    expect(liveRaw.open).toBe(true)
    expect(liveRaw.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 })

    // #then — post-init state is coherent: both getters resolve the new handle
    expect(getIndexDatabase()).toBe(live)
    expect(getRawIndexDatabase()).toBe(liveRaw)

    // #then — the returning leak is visible in the diagnostic logs
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('previous index connection'),
      expect.any(Error)
    )

    refusingClose.mockRestore()
    orphanRaw.close()
  })

  it('closes databases and resets getters', () => {
    initDatabase(dataDbPath)
    initIndexDatabase(indexDbPath)

    closeAllDatabases()

    expect(() => getDatabase()).toThrow('Database not initialized')
    expect(() => getIndexDatabase()).toThrow('Index database not initialized')
  })

  it('checks index health for missing, corrupt, and healthy states', () => {
    const missingPath = path.join(tempDir, 'missing.db')
    expect(checkIndexHealth(missingPath)).toBe('missing')

    const corruptPath = path.join(tempDir, 'corrupt.db')
    const sqlite = new Database(corruptPath)
    sqlite.exec('CREATE TABLE test (id TEXT)')
    sqlite.close()
    expect(checkIndexHealth(corruptPath)).toBe('corrupt')

    const healthyPath = path.join(tempDir, 'healthy.db')
    runIndexMigrations(healthyPath)
    expect(checkIndexHealth(healthyPath)).toBe('healthy')
  })

  it('enforces timeouts on long-running operations', async () => {
    const result = await withTimeout(async () => 'ok', 50)
    expect(result).toBe('ok')

    vi.useFakeTimers()
    const pending = withTimeout(() => new Promise(() => undefined), 10)

    const expectation = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10)
    await expectation
  })
})
