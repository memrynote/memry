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
   * Copies drizzle-data/ to a temp folder with 0035 and everything after it
   * stripped (SQL files + journal entries) so a database migrated from it is
   * shaped like a production install that pre-dates the canvas tables. Looks
   * up 0035 by tag (not "last entry") so later migrations added after it
   * don't break this helper.
   */
  function makePre0035Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0035')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0035_spatial_canvas')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    const removed = journal.entries.splice(cutoff)
    for (const entry of removed) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
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

describe('0036_canvas_assets migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-assets-migrate-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Copies drizzle-data/ to a temp folder with 0036 stripped (SQL file + last
   * journal entry) so a database migrated from it is shaped like a production
   * install that pre-dates the canvas_assets table.
   */
  function makePre0036Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0036')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    fs.rmSync(path.join(copy, '0036_canvas_assets.sql'))
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    expect(journal.entries[journal.entries.length - 1].tag).toBe('0036_canvas_assets')
    journal.entries.pop()
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

  it('creates canvas_assets when upgrading an existing pre-0036 database', () => {
    const dbPath = path.join(tempDir, 'data.db')
    const sqlite = new Database(dbPath)
    const db = drizzle(sqlite)

    migrate(db, { migrationsFolder: makePre0036Folder() })
    expect(tableNames(sqlite)).not.toContain('canvas_assets')
    sqlite
      .prepare(
        "INSERT INTO canvases (id, vault_id, snapshot_ciphertext, vector_clock, created_at, updated_at) VALUES ('c-pre', 'v1', 'ct', '{}', 1, 1)"
      )
      .run()

    migrate(db, { migrationsFolder: migrationsDir })

    const names = tableNames(sqlite)
    expect(names).toContain('canvas_assets')
    const kept = sqlite.prepare("SELECT id FROM canvases WHERE id = 'c-pre'").get() as {
      id: string
    }
    expect(kept.id).toBe('c-pre')
    sqlite.close()
  })

  it('raw SQL statements are idempotent when executed twice', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    const statements = fs
      .readFileSync(path.join(migrationsDir, '0036_canvas_assets.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    expect(statements.length).toBeGreaterThanOrEqual(3)
    for (let round = 0; round < 2; round++) {
      for (const statement of statements) {
        expect(() => sqlite.exec(statement)).not.toThrow()
      }
    }
    sqlite.close()
  })

  it('creates the expected columns', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    const columns = sqlite.pragma('table_info(canvas_assets)') as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]))

    expect(Object.keys(byName).sort()).toEqual(
      [
        'vault_id',
        'canvas_id',
        'content_hash',
        'attachment_id',
        'file_id',
        'filename',
        'mime_type',
        'size_bytes',
        'chunk_hashes',
        'created_at'
      ].sort()
    )
    for (const name of Object.keys(byName)) {
      expect(byName[name].notnull, `${name} should be NOT NULL`).toBe(1)
    }
    expect(byName.size_bytes.type).toBe('INTEGER')
    expect(byName.created_at.type).toBe('INTEGER')
    expect(byName.canvas_id.pk).toBeGreaterThan(0)
    expect(byName.content_hash.pk).toBeGreaterThan(0)
    expect(byName.vault_id.pk).toBe(0)

    sqlite.close()
  })

  it('creates the FK cascade, composite PK, and both indexes', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')

    const fks = sqlite.pragma('foreign_key_list(canvas_assets)') as {
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
      expect.arrayContaining(['idx_canvas_assets_dedup', 'idx_canvas_assets_attachment'])
    )

    sqlite
      .prepare(
        "INSERT INTO canvases (id, vault_id, snapshot_ciphertext, vector_clock, created_at, updated_at) VALUES ('c1', 'v1', 'ct', '{}', 1, 1)"
      )
      .run()
    const insertAsset = sqlite.prepare(
      "INSERT INTO canvas_assets (vault_id, canvas_id, content_hash, attachment_id, file_id, filename, mime_type, size_bytes, chunk_hashes, created_at) VALUES ('v1', 'c1', 'hash1', 'att1', 'file1', 'img.png', 'image/png', 1234, '[]', 1)"
    )
    insertAsset.run()
    // Duplicate (canvas_id, content_hash) violates the composite PK.
    expect(() => insertAsset.run()).toThrow(/UNIQUE|PRIMARY/i)

    sqlite.prepare("DELETE FROM canvases WHERE id = 'c1'").run()
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM canvas_assets WHERE canvas_id = 'c1'")
      .get() as { n: number }
    expect(remaining.n).toBe(0)
    sqlite.close()
  })
})
