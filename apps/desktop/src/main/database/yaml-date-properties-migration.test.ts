import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INDEX_MIGRATIONS = join(__dirname, 'drizzle-index')
const MIGRATION_TAG = '0025_unquoted_yaml_dates'

const tempDirs: string[] = []

function migrationsBefore(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bbf43-index-migrations-'))
  tempDirs.push(dir)
  cpSync(INDEX_MIGRATIONS, dir, { recursive: true })
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[]
  }
  const cut = journal.entries.findIndex((entry) => entry.tag === tag)
  expect(cut, `${tag} is in the journal`).toBeGreaterThan(0)
  journal.entries = journal.entries.slice(0, cut)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('index migration for unquoted YAML dates (BBF-43)', () => {
  it('rewrites property rows older builds stored as the JSON text of a Date', () => {
    const sqlite = new Database(':memory:')
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: migrationsBefore(MIGRATION_TAG) })

    sqlite
      .prepare(
        `INSERT INTO note_cache (id, path, title, content_hash, word_count, character_count, created_at, modified_at, indexed_at)
         VALUES ('n1', 'notes/n1.md', 'n1', 'h', 0, 0, '2026-01-01', '2026-01-01', '2026-01-01')`
      )
      .run()
    const insert = sqlite.prepare(
      'INSERT INTO note_properties (note_id, name, value, type) VALUES (?, ?, ?, ?)'
    )
    insert.run('n1', 'due', JSON.stringify(new Date('2026-10-07')), 'text')
    insert.run('n1', 'at', JSON.stringify(new Date('2026-09-01T08:30:00.000Z')), 'text')
    insert.run('n1', 'stage', JSON.stringify(new Date('2026-10-08')), 'select')
    insert.run('n1', 'quote', '"2026-10-07T00:00:00.000Z" was the date', 'text')
    insert.run('n1', 'plain', '2026-10-09', 'text')

    migrate(db, { migrationsFolder: INDEX_MIGRATIONS })

    expect(
      sqlite.prepare('SELECT name, value, type FROM note_properties ORDER BY rowid').all()
    ).toEqual([
      { name: 'due', value: '2026-10-07', type: 'date' },
      { name: 'at', value: '2026-09-01T08:30:00.000Z', type: 'date' },
      { name: 'stage', value: '2026-10-08', type: 'select' },
      { name: 'quote', value: '"2026-10-07T00:00:00.000Z" was the date', type: 'text' },
      { name: 'plain', value: '2026-10-09', type: 'text' }
    ])
    sqlite.close()
  })
})
