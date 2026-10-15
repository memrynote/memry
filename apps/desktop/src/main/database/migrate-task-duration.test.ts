import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { runMigrations } from './migrate'

describe('0075_task_duration migration', () => {
  let tempDir: string
  const migrationsDir = path.join(__dirname, 'drizzle-data')

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-task-duration-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function migrationsBefore0075(): string {
    const copy = path.join(tempDir, 'migrations-before-0075')
    fs.cpSync(migrationsDir, copy, { recursive: true })
    const journalPath = path.join(copy, 'meta', '_journal.json')
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[]
    }
    const cutoff = journal.entries.findIndex((e) => e.tag === '0075_task_duration')
    expect(cutoff).toBeGreaterThanOrEqual(0)
    for (const entry of journal.entries.splice(cutoff)) {
      fs.rmSync(path.join(copy, `${entry.tag}.sql`))
    }
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    return copy
  }

  it('adds a null duration_minutes to tasks that existed before the upgrade', () => {
    const dbPath = path.join(tempDir, 'data.db')
    const sqlite = new Database(dbPath)
    migrate(drizzle(sqlite), { migrationsFolder: migrationsBefore0075() })
    sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Inbox')").run()
    sqlite
      .prepare(
        "INSERT INTO tasks (id, project_id, title, due_date, due_time) VALUES ('t1', 'p1', 'Old', '2026-03-02', '09:00')"
      )
      .run()
    sqlite.close()

    runMigrations(dbPath)

    const after = new Database(dbPath)
    expect(
      after.prepare("SELECT title, due_time, duration_minutes FROM tasks WHERE id = 't1'").get()
    ).toEqual({ title: 'Old', due_time: '09:00', duration_minutes: null })
    after.prepare("UPDATE tasks SET duration_minutes = 45 WHERE id = 't1'").run()
    expect(after.prepare("SELECT duration_minutes FROM tasks WHERE id = 't1'").get()).toEqual({
      duration_minutes: 45
    })
    after.close()
  })
})
