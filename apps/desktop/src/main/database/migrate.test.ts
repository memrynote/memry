import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { runMigrations, runIndexMigrations } from './migrate'

describe('database migrations', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-migrate-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates core tables for data.db', () => {
    const dataDbPath = path.join(tempDir, 'data.db')
    runMigrations(dataDbPath)

    const sqlite = new Database(dataDbPath, { readonly: true })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
    const names = tables.map((table) => table.name)

    expect(names).toEqual(
      expect.arrayContaining([
        'projects',
        'statuses',
        'tasks',
        'inbox_items',
        'settings',
        'note_metadata',
        'property_definitions',
        'sync_devices',
        'sync_queue',
        'sync_state',
        'sync_history'
      ])
    )

    sqlite.close()
  })

  it('creates note cache tables for index.db', () => {
    const indexDbPath = path.join(tempDir, 'index.db')
    runIndexMigrations(indexDbPath)

    const sqlite = new Database(indexDbPath, { readonly: true })
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
    const names = tables.map((table) => table.name)

    expect(names).toEqual(
      expect.arrayContaining(['note_cache', 'note_links', 'note_tags', 'property_definitions'])
    )

    sqlite.close()
  })
})

describe('0035_spatial_canvas migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-migrate-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Copies drizzle-data/ to a temp folder with 0035+ stripped (SQL files + last
   * journal entries) so a database migrated from it is shaped like a production
   * install that pre-dates the canvas tables.
   */
  function makePre0035Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0035')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    fs.rmSync(path.join(copy, '0035_spatial_canvas.sql'))
    fs.rmSync(path.join(copy, '0036_project_links.sql'))
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    // Remove 0036 and 0035 entries to get a pre-0035 database
    while (
      journal.entries.length > 0 &&
      (journal.entries[journal.entries.length - 1].tag === '0036_project_links' ||
        journal.entries[journal.entries.length - 1].tag === '0035_spatial_canvas')
    ) {
      journal.entries.pop()
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  function tableNames(sqlite: InstanceType<typeof Database>): string[] {
    return (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
    ).map((t) => t.name)
  }

  // Drizzle's migrator skips already-applied migrations by journal `when` and
  // never re-executes or hash-verifies SQL, so "run runMigrations twice" is
  // green-by-construction. The real upgrade-path risk is a silent skip on an
  // existing install — assert the tables actually appear on a DB that already
  // applied 0000-0034 and that pre-existing rows survive.
  it('creates canvas tables when upgrading an existing pre-0035 database', () => {
    const dbPath = path.join(tempDir, 'data.db')
    const sqlite = new Database(dbPath)
    const db = drizzle(sqlite)

    migrate(db, { migrationsFolder: makePre0035Folder() })
    expect(tableNames(sqlite)).not.toContain('canvases')
    sqlite.prepare("INSERT INTO home_pages (id, name) VALUES ('hp1', 'Home')").run()

    migrate(db, { migrationsFolder: migrationsDir })

    const names = tableNames(sqlite)
    expect(names).toContain('canvases')
    expect(names).toContain('canvas_entity_refs')
    const kept = sqlite.prepare("SELECT name FROM home_pages WHERE id = 'hp1'").get() as {
      name: string
    }
    expect(kept.name).toBe('Home')
    sqlite.close()
  })

  it('raw SQL statements are idempotent when executed twice', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    const statements = fs
      .readFileSync(path.join(migrationsDir, '0035_spatial_canvas.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    expect(statements.length).toBeGreaterThanOrEqual(5)
    for (let round = 0; round < 2; round++) {
      for (const statement of statements) {
        expect(() => sqlite.exec(statement)).not.toThrow()
      }
    }
    sqlite.close()
  })

  it('creates the FK cascade, composite PK, and both indexes', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')

    const fks = sqlite.pragma('foreign_key_list(canvas_entity_refs)') as {
      table: string
      from: string
      to: string
      on_delete: string
    }[]
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ table: 'canvases', from: 'canvas_id', on_delete: 'CASCADE' })

    const indexNames = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as {
        name: string
      }[]
    ).map((i) => i.name)
    expect(indexNames).toEqual(
      expect.arrayContaining(['canvases_by_vault', 'canvases_by_updated', 'idx_canvas_refs_entity'])
    )

    sqlite
      .prepare(
        "INSERT INTO canvases (id, vault_id, snapshot_ciphertext, vector_clock, created_at, updated_at) VALUES ('c1', 'v1', 'ct', '{}', 1, 1)"
      )
      .run()
    const insertRef = sqlite.prepare(
      "INSERT INTO canvas_entity_refs (canvas_id, entity_type, entity_id) VALUES ('c1', 'note', 'n1')"
    )
    insertRef.run()
    expect(() => insertRef.run()).toThrow(/UNIQUE|PRIMARY/i)

    sqlite.prepare("DELETE FROM canvases WHERE id = 'c1'").run()
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM canvas_entity_refs WHERE canvas_id = 'c1'")
      .get() as { n: number }
    expect(remaining.n).toBe(0)
    sqlite.close()
  })
})
