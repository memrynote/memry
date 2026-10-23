/**
 * #3247: SQLITE_CORRUPT from a query mid-session reaches the recovery
 * listener, through the same prepare/raw/all path Drizzle uses.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

import { instrumentDataDbConnection, onDataDbCorruption } from './data-db-corruption-signal'

let dir: string
let dbPath: string
let db: Database.Database | null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-data-db-signal-'))
  dbPath = path.join(dir, 'data.db')
  db = null
})

afterEach(() => {
  onDataDbCorruption(null)
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A valid header and schema page, then garbage over every table page. */
function writeCorruptDb(): void {
  const seed = new Database(dbPath)
  seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)')
  const insert = seed.prepare('INSERT INTO t (body) VALUES (?)')
  for (let i = 0; i < 500; i += 1) insert.run('x'.repeat(200))
  const pageSize = seed.pragma('page_size', { simple: true }) as number
  seed.close()
  const bytes = fs.readFileSync(dbPath)
  bytes.fill(0x7f, pageSize)
  fs.writeFileSync(dbPath, bytes)
}

describe('data.db runtime corruption signal', () => {
  it('reports SQLITE_CORRUPT from a query and rethrows it unchanged', () => {
    writeCorruptDb()
    db = new Database(dbPath)
    instrumentDataDbConnection(db)
    const listener = vi.fn()
    onDataDbCorruption(listener)

    const stmt = db.prepare('SELECT * FROM t')
    expect(() => stmt.raw().all()).toThrow(/malformed|corrupt/i)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toBe(dbPath)
    expect((listener.mock.calls[0][1] as { code: string }).code).toMatch(/^SQLITE_CORRUPT/)
  })

  it('ignores errors that are not corruption', () => {
    db = new Database(dbPath)
    instrumentDataDbConnection(db)
    const listener = vi.fn()
    onDataDbCorruption(listener)

    expect(() => db!.prepare('SELECT * FROM missing')).toThrow('no such table: missing')
    db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY)')
    db.prepare('INSERT INTO u (id) VALUES (1)').run()
    expect(() => db!.prepare('INSERT INTO u (id) VALUES (1)').run()).toThrow(/UNIQUE/)

    expect(listener).not.toHaveBeenCalled()
  })
})
