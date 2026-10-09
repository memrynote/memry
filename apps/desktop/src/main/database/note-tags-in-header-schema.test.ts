import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { runIndexMigrations } from './migrate'

const MIGRATIONS = path.join(__dirname, 'drizzle-index')

describe('0025_note_tags_in_header migration', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-in-header-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** The index migrations an install had before this one. */
  function makePre0024Folder(): string {
    const copy = path.join(tempDir, 'drizzle-index-pre-0024')
    fs.cpSync(MIGRATIONS, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0025_note_tags_in_header')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  function seedTaggedNote(sqlite: Database.Database): void {
    sqlite
      .prepare(
        "INSERT INTO note_cache (id, path, title, created_at, modified_at) VALUES ('n1', 'a.md', 'A', '2026-01-01', '2026-01-01')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO note_tags (note_id, tag, position, pinned_at) VALUES ('n1', 'work', 0, '2026-01-02')"
      )
      .run()
  }

  it('adds an unresolved flag to the tag rows an existing install already has', () => {
    const sqlite = new Database(path.join(tempDir, 'index.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0024Folder() })
    seedTaggedNote(sqlite)

    migrate(db, { migrationsFolder: MIGRATIONS })
    migrate(db, { migrationsFolder: MIGRATIONS })

    expect(
      sqlite.prepare('SELECT note_id, tag, position, pinned_at, in_header FROM note_tags').all()
    ).toEqual([
      { note_id: 'n1', tag: 'work', position: 0, pinned_at: '2026-01-02', in_header: null }
    ])
    const indexes = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'note_tags'")
        .all() as { name: string }[]
    ).map((row) => row.name)
    expect(indexes).toContain('idx_note_tags_tag_header')
    sqlite.close()
  })

  it('is inert for an older build that opens the upgraded index', () => {
    const dbPath = path.join(tempDir, 'index.db')
    runIndexMigrations(dbPath)
    const sqlite = new Database(dbPath)
    seedTaggedNote(sqlite)

    expect(() => migrate(drizzle(sqlite), { migrationsFolder: makePre0024Folder() })).not.toThrow()

    expect(sqlite.prepare('SELECT tag, in_header FROM note_tags').all()).toEqual([
      { tag: 'work', in_header: null }
    ])
    sqlite.close()
  })
})
