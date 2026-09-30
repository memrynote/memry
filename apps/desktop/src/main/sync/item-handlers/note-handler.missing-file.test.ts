/**
 * The startup reconcile drops a note's index row once its file is gone, while
 * the data DB keeps the note. A remote update for that note then runs against
 * an index with no parent row. Both databases here are real. Neither the app
 * nor this test sets `foreign_keys` on the index DB, and better-sqlite3 builds
 * with SQLITE_DEFAULT_FOREIGN_KEYS=1, so both enforce foreign keys and a write
 * the schema rejects fails here as it fails on a user's device (#2538).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-missing-file-'))

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getIndexDatabase: () => indexDb.db
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: VAULT_ROOT }))
}))

vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

import { noteHandler } from './note-handler'
import { getNoteMetadataById } from '@memry/storage-data'

const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

describe('noteHandler.applyUpsert — note whose file is missing at its recorded path', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })

    dataDb.db
      .insert(noteMetadata)
      .values({
        id: 'n1',
        path: 'gone.md',
        title: 'gone',
        fileType: 'markdown',
        clock: { 'device-A': 1 },
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it('applies a remote tags and properties update', () => {
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      {
        title: 'gone',
        tags: ['remote'],
        pinnedTags: ['remote'],
        properties: { status: 'done' },
        clock: REMOTE_CLOCK
      },
      REMOTE_CLOCK
    )

    expect(result).toBe('applied')
    expect(getNoteMetadataById(dataDb.db as unknown as DrizzleDb, 'n1')?.clock).toEqual(
      REMOTE_CLOCK
    )
  })
})
