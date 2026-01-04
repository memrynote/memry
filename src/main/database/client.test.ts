import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { runIndexMigrations } from './migrate'
import {
  initDatabase,
  initIndexDatabase,
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase,
  closeAllDatabases,
  checkIndexHealth,
  withTimeout
} from './client'

describe('database client', () => {
  let tempDir: string
  let dataDbPath: string
  let indexDbPath: string

  beforeEach(() => {
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
    expect(raw.pragma('cache_size', { simple: true })).toBe(-128000)
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
