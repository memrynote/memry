/**
 * data.db integrity detection.
 *
 * index.db is a cache and has a delete-and-rebuild path. data.db has neither:
 * tasks, projects, bookmarks, reminders, calendar rows and the whole sync state
 * live only there. When it goes malformed the app reports a dozen separate
 * SQLITE_CORRUPT errors, one per handler that happens to read it, and none of
 * them name the file. `isDataDatabaseCorrupt` takes that verdict once.
 *
 * The corruption is genuine, not simulated: the page holding the table's rows
 * is overwritten on disk, which is what a torn write or a bad sector looks like
 * from SQLite's side.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { closeDatabase, initDatabase, isDataDatabaseCorrupt } from './client'

const PAGE_SIZE = 4096

let dir: string
let dbPath: string

function seedRows(): void {
  const db = new Database(dbPath)
  db.pragma(`page_size = ${PAGE_SIZE}`)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE notes_probe (id INTEGER PRIMARY KEY, body TEXT)')
  const insert = db.prepare('INSERT INTO notes_probe (body) VALUES (?)')
  const many = db.transaction(() => {
    for (let i = 0; i < 400; i += 1) insert.run(`row-${i}-${'x'.repeat(200)}`)
  })
  many()
  db.close()
}

/** Overwrite the interior of the file, past the header, where the table pages live. */
function garbleTablePages(): void {
  const fd = fs.openSync(dbPath, 'r+')
  const garbage = Buffer.alloc(PAGE_SIZE * 3, 0x7f)
  fs.writeSync(fd, garbage, 0, garbage.length, PAGE_SIZE * 2)
  fs.closeSync(fd)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-data-db-'))
  dbPath = path.join(dir, 'data.db')
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('isDataDatabaseCorrupt', () => {
  it('passes a healthy data.db', () => {
    seedRows()
    initDatabase(dbPath)

    expect(isDataDatabaseCorrupt()).toBe(false)
  })

  it('reports a data.db whose table pages were overwritten on disk', () => {
    seedRows()
    garbleTablePages()
    initDatabase(dbPath)

    expect(isDataDatabaseCorrupt()).toBe(true)
  })

  it('is false when no data.db is open, so it cannot fire before a vault exists', () => {
    closeDatabase()

    expect(isDataDatabaseCorrupt()).toBe(false)
  })
})
