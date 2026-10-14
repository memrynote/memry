/**
 * data.db recovery (#2595): the corrupt file is moved aside, never deleted,
 * and pending sync queue rows are salvaged from it and replayed into the
 * fresh database so unsynced changes still reach the server.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { moveAsideCorruptDataDb, replaySyncQueue, salvageSyncQueue } from './data-db-recovery'

const QUEUE_DDL = `CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, item_id TEXT NOT NULL, operation TEXT NOT NULL,
  payload TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER, error_message TEXT, created_at INTEGER NOT NULL)`

let dir: string
let dbPath: string
let open: Database.Database | null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-data-db-recovery-'))
  dbPath = path.join(dir, 'data.db')
  open = null
})

afterEach(() => {
  open?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function seedQueue(count: number): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  db.exec(QUEUE_DDL)
  const insert = db.prepare(
    "INSERT INTO sync_queue (id, type, item_id, operation, payload, created_at) VALUES (?, 'task', ?, 'update', ?, 1)"
  )
  for (let i = 0; i < count; i += 1) insert.run(`q${i}`, `item${i}`, `{"n":${i}}`)
  return db
}

describe('data.db recovery', () => {
  it('moves the file and its uncheckpointed WAL aside, then replays the queue into a fresh db', () => {
    open = seedQueue(3) // held open so the rows live only in the WAL

    const backup = moveAsideCorruptDataDb(dbPath, 1700000000000)
    open.close()
    open = null

    expect(backup).toBe(`${dbPath}.corrupt-1700000000000`)
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(backup)).toBe(true)

    const salvaged = salvageSyncQueue(backup)
    expect(salvaged.map((r) => r.id)).toEqual(['q0', 'q1', 'q2'])

    open = new Database(dbPath)
    open.exec(QUEUE_DDL)
    expect(replaySyncQueue(open, salvaged)).toBe(3)
    expect(open.prepare('SELECT item_id, payload FROM sync_queue ORDER BY id').all()).toEqual([
      { item_id: 'item0', payload: '{"n":0}' },
      { item_id: 'item1', payload: '{"n":1}' },
      { item_id: 'item2', payload: '{"n":2}' }
    ])
  })

  it('never overwrites an earlier backup taken in the same millisecond', () => {
    fs.writeFileSync(dbPath, 'a')
    const first = moveAsideCorruptDataDb(dbPath, 5)
    fs.writeFileSync(dbPath, 'b')
    const second = moveAsideCorruptDataDb(dbPath, 5)

    expect(second).not.toBe(first)
    expect(fs.readFileSync(first, 'utf8')).toBe('a')
    expect(fs.readFileSync(second, 'utf8')).toBe('b')
  })

  it('returns what it can, without throwing, when the backup is unreadable', () => {
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 0x7f))
    const backup = moveAsideCorruptDataDb(dbPath)

    expect(salvageSyncQueue(backup)).toEqual([])
  })
})
