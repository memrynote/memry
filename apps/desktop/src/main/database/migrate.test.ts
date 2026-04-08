import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
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
