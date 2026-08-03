import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'drizzle-index/0020_freezing_triathlon.sql'

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE note_cache (
      id TEXT PRIMARY KEY NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL
    );
  `)
  db.exec(readFileSync(join(__dirname, MIGRATION), 'utf8'))
  return db
}

describe('property_refs migration', () => {
  it('creates the table with the expected columns', () => {
    const db = migratedDb()
    const cols = db.prepare('PRAGMA table_info(property_refs)').all() as { name: string }[]
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['property_name', 'source_note_id', 'target_id', 'target_type'].sort()
    )
  })

  it('indexes the target for reverse lookups', () => {
    const db = migratedDb()
    const indexes = db.prepare('PRAGMA index_list(property_refs)').all() as { name: string }[]
    expect(indexes.some((i) => i.name === 'idx_property_refs_target')).toBe(true)
  })

  it('cascades when the source note is deleted', () => {
    const db = migratedDb()
    db.prepare("INSERT INTO note_cache (id, path, title) VALUES ('nte_1', 'a.md', 'A')").run()
    db.prepare(
      `INSERT INTO property_refs (source_note_id, property_name, target_type, target_id)
       VALUES ('nte_1', 'father', 'note', 'nte_dad')`
    ).run()

    db.prepare("DELETE FROM note_cache WHERE id = 'nte_1'").run()

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM property_refs').get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('rejects a duplicate (note, property, type, target) row', () => {
    const db = migratedDb()
    db.prepare("INSERT INTO note_cache (id, path, title) VALUES ('nte_1', 'a.md', 'A')").run()
    const insert = (): void => {
      db.prepare(
        `INSERT INTO property_refs (source_note_id, property_name, target_type, target_id)
         VALUES ('nte_1', 'father', 'note', 'nte_dad')`
      ).run()
    }
    insert()
    expect(insert).toThrow()
  })
})
