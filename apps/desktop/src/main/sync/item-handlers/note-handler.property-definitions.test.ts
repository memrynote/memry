/**
 * A pulled note update learns property types from its frontmatter. It must
 * not overwrite the definition this device already holds: the options,
 * default and color came from the definition sync, not from the note.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-propdefs-'))

let dataDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('@main/database/queries/notes', () => ({
  noteCacheExists: vi.fn(() => true),
  getNoteCacheById: vi.fn(() => undefined),
  getNoteCacheByPath: vi.fn(() => undefined),
  getNoteTags: vi.fn(() => []),
  setNoteTags: vi.fn(),
  updateNoteCache: vi.fn(),
  extractDateFromPath: vi.fn(() => null),
  setNoteProperties: vi.fn(
    (
      _db: unknown,
      _id: string,
      properties: Record<string, unknown>,
      getType: (name: string, value: unknown) => string
    ) => {
      for (const [name, value] of Object.entries(properties)) getType(name, value)
    }
  )
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: VAULT_ROOT }))
}))

vi.mock('../note-sync', () => ({
  extractFolderFromPath: vi.fn(() => null)
}))

vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

import { noteHandler } from './note-handler'

const NOTE_PATH = 'n1.md'
const OPTIONS = JSON.stringify([{ value: 'Draft', color: 'gray' }])

describe('noteHandler.applyUpsert — property definitions on a synced update', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    dataDb = createTestDataDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    fs.mkdirSync(VAULT_ROOT, { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), '---\ntags: []\n---\n\nbody\n', 'utf-8')
    dataDb.db
      .insert(noteMetadata)
      .values({
        id: 'n1',
        path: NOTE_PATH,
        title: 'n1',
        fileType: 'markdown',
        clock: { 'device-A': 1 },
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
    dataDb.db
      .insert(propertyDefinitions)
      .values({
        name: 'Stage',
        type: 'select',
        options: OPTIONS,
        defaultValue: 'Draft',
        color: 'blue',
        clock: { 'device-A': 1 }
      })
      .run()
  })

  afterEach(() => {
    dataDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it('keeps the options, default and color of a definition the note uses', () => {
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { properties: { Stage: 'Draft', Rating: 4 }, clock: { 'device-A': 1, 'device-B': 1 } },
      { 'device-A': 1, 'device-B': 1 }
    )

    expect(result).toBe('applied')
    const stage = dataDb.db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, 'Stage'))
      .get()
    expect(stage).toMatchObject({
      type: 'select',
      options: OPTIONS,
      defaultValue: 'Draft',
      color: 'blue'
    })
    const rating = dataDb.db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, 'Rating'))
      .get()
    expect(rating).toMatchObject({ type: 'number' })
  })
})
