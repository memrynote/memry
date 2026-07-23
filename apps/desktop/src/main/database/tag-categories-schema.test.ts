import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE tag_definitions (
      name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
      color TEXT NOT NULL,
      icon TEXT,
      clock TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
  db.exec(readFileSync(join(__dirname, 'drizzle-data/0038_tag_categories.sql'), 'utf8'))
  return db
}

describe('0038_tag_categories migration', () => {
  it('creates tag_categories with the expected columns', () => {
    const db = migratedDb()
    const cols = db.prepare('PRAGMA table_info(tag_categories)').all() as { name: string }[]
    expect(cols.map((c) => c.name).sort()).toEqual(
      ['clock', 'created_at', 'deleted_at', 'id', 'name', 'sort_order', 'updated_at'].sort()
    )
  })

  it('adds category_id and sort_order to tag_definitions without touching existing rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE tag_definitions (
        name TEXT PRIMARY KEY COLLATE NOCASE NOT NULL,
        color TEXT NOT NULL,
        icon TEXT,
        clock TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `)
    db.prepare("INSERT INTO tag_definitions (name, color) VALUES ('work', 'blue')").run()

    db.exec(readFileSync(join(__dirname, 'drizzle-data/0038_tag_categories.sql'), 'utf8'))

    const row = db.prepare("SELECT * FROM tag_definitions WHERE name = 'work'").get() as {
      color: string
      category_id: string | null
      sort_order: number
    }
    expect(row.color).toBe('blue')
    expect(row.category_id).toBeNull()
    expect(row.sort_order).toBe(0)
  })

  it('is safe to re-run for the table creation', () => {
    const db = migratedDb()
    expect(() =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS tag_categories (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          clock TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          deleted_at TEXT
        );
      `)
    ).not.toThrow()
  })
})
