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
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0036_canvas_assets')
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

describe('0043_bookmark_reminder_sync migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-bookmark-reminder-migrate-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /**
   * Copies drizzle-data/ to a temp folder with 0043 and everything after it
   * stripped (SQL files + journal entries) so a database migrated from it is
   * shaped like a production install: nanoid bookmark ids, ad-hoc reminder ids,
   * no clock columns.
   */
  function makePre0043Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0043')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0043_bookmark_reminder_sync')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    const removed = journal.entries.splice(cutoff)
    for (const entry of removed) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  function columnNames(sqlite: InstanceType<typeof Database>, table: string): string[] {
    return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
  }

  /** Opens a database migrated only up to 0039 — the pre-upgrade production shape. */
  function openPre0043(): {
    sqlite: InstanceType<typeof Database>
    db: ReturnType<typeof drizzle>
  } {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0043Folder() })
    return { sqlite, db }
  }

  // Drizzle's migrator skips already-applied migrations by journal `when` and
  // never re-executes SQL, so running migrations twice on a fresh database is
  // green-by-construction. The only meaningful test is the upgrade path: a
  // database that already applied 0000-0039 and holds legacy rows.
  it('rewrites bookmark ids deterministically and preserves every row', () => {
    const { sqlite, db } = openPre0043()
    expect(columnNames(sqlite, 'bookmarks')).not.toContain('clock')

    const insert = sqlite.prepare(
      `INSERT INTO bookmarks (id, item_type, item_id, position, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    insert.run('nanoid_legacy_1', 'note', 'note_abc', 0, '2026-01-01T00:00:00.000Z')
    // This row's legacy id is exactly the deterministic id the row above will
    // take, so a single-pass rewrite would collide on the primary key.
    insert.run('bmk_note_note_abc', 'task', 'task_xyz', 1, '2026-01-02T00:00:00.000Z')

    migrate(db, { migrationsFolder: migrationsDir })

    const rows = sqlite.prepare('SELECT * FROM bookmarks ORDER BY position').all() as {
      id: string
      item_type: string
      item_id: string
      position: number
      created_at: string
      clock: string | null
      synced_at: string | null
    }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('bmk_note_note_abc')
    expect(rows[0].item_id).toBe('note_abc')
    expect(rows[0].position).toBe(0)
    expect(rows[0].created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(rows[0].clock).toBeNull()
    expect(rows[0].synced_at).toBeNull()
    expect(rows[1].id).toBe('bmk_task_task_xyz')
    expect(rows[1].item_id).toBe('task_xyz')
    sqlite.close()
  })

  it('collapses duplicate note_date reminders before rewriting ids', () => {
    const { sqlite, db } = openPre0043()
    expect(columnNames(sqlite, 'reminders')).not.toContain('clock')

    const insert = sqlite.prepare(
      `INSERT INTO reminders (id, target_type, target_id, remind_at, anchor_id, status, created_at, modified_at)
       VALUES (?, 'note_date', ?, ?, ?, 'pending', ?, ?)`
    )
    insert.run(
      'rem_a',
      'note_1',
      '2026-08-03T09:00:00.000Z',
      'anchor_1',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )
    insert.run(
      'rem_b',
      'note_1',
      '2026-08-03T09:00:00.000Z',
      'anchor_1',
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z'
    )
    // A different anchor on the same note is a different reminder — it survives.
    insert.run(
      'rem_c',
      'note_1',
      '2026-08-04T09:00:00.000Z',
      'anchor_2',
      '2026-01-03T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z'
    )

    migrate(db, { migrationsFolder: migrationsDir })

    const rows = sqlite
      .prepare("SELECT id, created_at FROM reminders WHERE target_type = 'note_date' ORDER BY id")
      .all() as { id: string; created_at: string }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('rem_nd_note_1_anchor_1')
    // MIN(id) survives the collapse: rem_a, not rem_b.
    expect(rows[0].created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(rows[1].id).toBe('rem_nd_note_1_anchor_2')
    sqlite.close()
  })

  it('leaves non-note_date reminder ids untouched', () => {
    const { sqlite, db } = openPre0043()

    sqlite
      .prepare(
        `INSERT INTO reminders (id, target_type, target_id, remind_at, status, created_at, modified_at)
         VALUES ('rem_keepme', 'note', 'note_1', '2026-08-03T09:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()
    // note_date rows without an anchor id are outside the rewrite too.
    sqlite
      .prepare(
        `INSERT INTO reminders (id, target_type, target_id, remind_at, status, created_at, modified_at)
         VALUES ('rem_no_anchor', 'note_date', 'note_1', '2026-08-03T09:00:00.000Z', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run()

    migrate(db, { migrationsFolder: migrationsDir })

    const ids = (
      sqlite.prepare('SELECT id FROM reminders ORDER BY id').all() as { id: string }[]
    ).map((r) => r.id)
    expect(ids).toEqual(['rem_keepme', 'rem_no_anchor'])
    sqlite.close()
  })
})

describe('0047_sync_queue_revive_dead_lettered migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sync-queue-revive-migrate-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Copy of drizzle-data/ with 0047 and everything after it stripped. */
  function makePre0047Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0047')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex(
      (e) => e.tag === '0047_sync_queue_revive_dead_lettered'
    )
    expect(cutoff).toBeGreaterThanOrEqual(0)
    const removed = journal.entries.splice(cutoff)
    for (const entry of removed) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  it('hands the retry budget back to rows an older build parked, and leaves the rest alone', () => {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0047Folder() })

    const insert = sqlite.prepare(
      `INSERT INTO sync_queue (id, type, item_id, operation, payload, priority, attempts, last_attempt, error_message, created_at)
       VALUES (?, 'note', ?, 'update', ?, 0, ?, ?, ?, ?)`
    )
    // Parked by the old in-cycle burn: unreachable and invisible in the UI.
    insert.run(
      'q_dead',
      'note_1',
      '{"title":"Parked"}',
      5,
      1785000000000,
      'SYNC_VALIDATION_FAILED',
      1784000000000
    )
    // Mid-budget and untouched rows must keep the attempts they earned.
    insert.run(
      'q_partial',
      'note_2',
      '{"title":"Halfway"}',
      2,
      1785000000000,
      'SYNC_VALIDATION_FAILED',
      1784000000000
    )
    insert.run('q_fresh', 'note_3', '{"title":"Fresh"}', 0, null, null, 1784000000000)

    migrate(db, { migrationsFolder: migrationsDir })

    const rows = sqlite
      .prepare('SELECT id, attempts, payload, error_message FROM sync_queue ORDER BY id')
      .all() as { id: string; attempts: number; payload: string; error_message: string | null }[]

    expect(rows.map((r) => [r.id, r.attempts])).toEqual([
      ['q_dead', 0],
      ['q_fresh', 0],
      ['q_partial', 2]
    ])
    // Row-preserving: the edit and its failure reason both survive the reset.
    expect(rows[0].payload).toBe('{"title":"Parked"}')
    expect(rows[0].error_message).toBe('SYNC_VALIDATION_FAILED')
    sqlite.close()
  })
})

describe('0055_task_canvases migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-task-canvases-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makePre0055Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0055')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0055_task_canvases')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    const removed = journal.entries.splice(cutoff)
    for (const entry of removed) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  function seedTaskWithNoteLink(sqlite: InstanceType<typeof Database>): void {
    sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Inbox')").run()
    sqlite
      .prepare(
        "INSERT INTO tasks (id, project_id, title, description) VALUES ('t1', 'p1', 'Ship it', 'body')"
      )
      .run()
    sqlite.prepare("INSERT INTO task_notes (task_id, note_id) VALUES ('t1', 'n1')").run()
  }

  it('leaves an existing task and its note links untouched when upgrading', () => {
    const dbPath = path.join(tempDir, 'data.db')
    const sqlite = new Database(dbPath)
    const db = drizzle(sqlite)

    migrate(db, { migrationsFolder: makePre0055Folder() })
    const preTables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
    ).map((t) => t.name)
    expect(preTables).not.toContain('task_canvases')
    seedTaskWithNoteLink(sqlite)

    migrate(db, { migrationsFolder: migrationsDir })

    const task = sqlite.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as {
      title: string
      description: string
      project_id: string
    }
    expect(task).toMatchObject({ title: 'Ship it', description: 'body', project_id: 'p1' })
    expect(sqlite.prepare('SELECT task_id, note_id FROM task_notes').all()).toEqual([
      { task_id: 't1', note_id: 'n1' }
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM task_canvases').get()).toEqual({ n: 0 })
    sqlite.close()
  })

  it('raw SQL statements are idempotent when executed twice', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    const statements = fs
      .readFileSync(path.join(migrationsDir, '0055_task_canvases.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)

    for (let round = 0; round < 2; round++) {
      for (const statement of statements) {
        expect(() => sqlite.exec(statement)).not.toThrow()
      }
    }
    sqlite.close()
  })

  it('cascades on task delete and has no foreign key to canvases', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)

    const sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')
    seedTaskWithNoteLink(sqlite)

    // No FK to `canvases`, so a link may be written before the canvas arrives.
    // That is what keeps sync apply order irrelevant.
    const fks = sqlite.pragma('foreign_key_list(task_canvases)') as {
      table: string
      from: string
      on_delete: string
    }[]
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ table: 'tasks', from: 'task_id', on_delete: 'CASCADE' })

    sqlite
      .prepare("INSERT INTO task_canvases (task_id, canvas_id) VALUES ('t1', 'absent-canvas')")
      .run()
    expect(() =>
      sqlite
        .prepare("INSERT INTO task_canvases (task_id, canvas_id) VALUES ('t1', 'absent-canvas')")
        .run()
    ).toThrow(/UNIQUE|PRIMARY KEY/)

    sqlite.prepare("DELETE FROM tasks WHERE id = 't1'").run()
    expect(sqlite.prepare('SELECT count(*) AS n FROM task_canvases').get()).toEqual({ n: 0 })
    sqlite.close()
  })
})

describe('0058_canvas_owner_note migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-owner-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('upgrades every canvas to free-standing, adopting only a well-formed captured owner', () => {
    const copy = path.join(tempDir, 'drizzle-data-pre-0058')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0058_canvas_owner_note')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))

    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: copy })

    const insertCanvas = sqlite.prepare(
      `INSERT INTO canvases (id, vault_id, title, snapshot_ciphertext, vector_clock, created_at, updated_at)
       VALUES (?, 'v1', ?, '', '{}', 1, 2)`
    )
    const capture = sqlite.prepare(
      'INSERT INTO sync_unknown_fields (type, item_id, fields, updated_at) VALUES (?, ?, ?, 1)'
    )
    for (const id of ['plain', 'captured', 'garbage', 'numeric', 'other-type']) {
      insertCanvas.run(id, `Title ${id}`)
    }
    // What a pre-0058 build with #2183 keeps when a newer peer names an owner.
    capture.run('canvas', 'captured', '{"ownerNoteId":"note-1","later":true}')
    capture.run('canvas', 'garbage', '{not json')
    capture.run('canvas', 'numeric', '{"ownerNoteId":5}')
    capture.run('note', 'other-type', '{"ownerNoteId":"note-2"}')

    migrate(db, { migrationsFolder: migrationsDir })

    const rows = sqlite
      .prepare('SELECT id, title, owner_note_id FROM canvases ORDER BY id')
      .all() as { id: string; title: string; owner_note_id: string | null }[]
    expect(rows).toEqual([
      { id: 'captured', title: 'Title captured', owner_note_id: 'note-1' },
      { id: 'garbage', title: 'Title garbage', owner_note_id: null },
      { id: 'numeric', title: 'Title numeric', owner_note_id: null },
      { id: 'other-type', title: 'Title other-type', owner_note_id: null },
      { id: 'plain', title: 'Title plain', owner_note_id: null }
    ])
    // The capture itself is left for the next apply to clear.
    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_unknown_fields').get()).toEqual({ n: 4 })
    sqlite.close()
  })
})

// #2301
describe('0059_sync_intents migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sync-intents-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makePre0059Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0059')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0059_sync_intents')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  it('adds an empty table and leaves existing rows untouched', () => {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0059Folder() })
    sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Inbox')").run()
    sqlite.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'Ship it')").run()
    sqlite
      .prepare(
        "INSERT INTO sync_queue (id, type, item_id, operation, payload, created_at) VALUES ('q1', 'note_body', 'n1', 'update', 'AAE=', 1)"
      )
      .run()

    migrate(db, { migrationsFolder: migrationsDir })

    expect(sqlite.prepare('SELECT id, title FROM tasks').all()).toEqual([
      { id: 't1', title: 'Ship it' }
    ])
    expect(sqlite.prepare('SELECT id, type FROM sync_queue').all()).toEqual([
      { id: 'q1', type: 'note_body' }
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_intents').get()).toEqual({ n: 0 })
    sqlite.close()
  })

  it('is inert for an older build that opens the upgraded database', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    const sqlite = new Database(dbPath)
    sqlite
      .prepare(
        "INSERT INTO sync_intents (type, item_id, op, created_at) VALUES ('task', 't1', 'update', 1)"
      )
      .run()

    expect(() => migrate(drizzle(sqlite), { migrationsFolder: makePre0059Folder() })).not.toThrow()

    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_intents').get()).toEqual({ n: 1 })
    sqlite.close()
  })
})

// #2409
describe('0061_sync_tombstone_clocks migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-tombstone-clocks-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function makePre0061Folder(): string {
    const copy = path.join(tempDir, 'drizzle-data-pre-0061')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0061_sync_tombstone_clocks')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  it('adds an empty table on a populated database and changes no row', () => {
    const sqlite = new Database(path.join(tempDir, 'data.db'))
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: makePre0061Folder() })
    sqlite
      .prepare(
        "INSERT INTO tag_definitions (name, color, clock) VALUES ('work', 'red', '{\"a\":2}')"
      )
      .run()
    sqlite
      .prepare(
        "INSERT INTO sync_pending_deletes (type, item_id, payload, created_at) VALUES ('journal', 'j2026-01-01', '{}', 1)"
      )
      .run()

    migrate(db, { migrationsFolder: migrationsDir })
    // Idempotent: a second run applies nothing and throws nothing.
    migrate(db, { migrationsFolder: migrationsDir })

    expect(sqlite.prepare('SELECT name, color, clock FROM tag_definitions').all()).toEqual([
      { name: 'work', color: 'red', clock: '{"a":2}' }
    ])
    expect(sqlite.prepare('SELECT type, item_id FROM sync_pending_deletes').all()).toEqual([
      { type: 'journal', item_id: 'j2026-01-01' }
    ])
    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_tombstone_clocks').get()).toEqual({
      n: 0
    })
    sqlite.close()
  })

  it('is inert for an older build that opens the upgraded database', () => {
    const dbPath = path.join(tempDir, 'data.db')
    runMigrations(dbPath)
    const sqlite = new Database(dbPath)
    sqlite
      .prepare(
        "INSERT INTO sync_tombstone_clocks (type, item_id, clock, updated_at) VALUES ('tag_definition', 'work', '{\"a\":2}', 1)"
      )
      .run()

    expect(() => migrate(drizzle(sqlite), { migrationsFolder: makePre0061Folder() })).not.toThrow()

    expect(sqlite.prepare('SELECT count(*) AS n FROM sync_tombstone_clocks').get()).toEqual({
      n: 1
    })
    sqlite.close()
  })
})

// #2301 review B-6/A-8: drizzle applies a migration only when its `when` is
// greater than the newest one already applied. Two stacked migrations that
// share a `when` (or go backwards) make every install that has the first skip
// the second, silently.
describe('data DB migration journal', () => {
  it('has strictly increasing `when` values in idx order', () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'drizzle-data', 'meta', '_journal.json'), 'utf8')
    ) as { entries: { idx: number; when: number; tag: string }[] }

    // Shipped with a `when` older than 0022's. Released history cannot be
    // rewritten, so it is the one pinned exception; nothing may join it.
    const shippedOutOfOrder = new Set(['0023_folder_configs'])
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx)
    let newest = { tag: '', when: -Infinity }
    for (const entry of entries) {
      if (shippedOutOfOrder.has(entry.tag)) continue
      expect(
        entry.when,
        `${entry.tag} must have a larger \`when\` than ${newest.tag}`
      ).toBeGreaterThan(newest.when)
      newest = entry
    }
  })
})
