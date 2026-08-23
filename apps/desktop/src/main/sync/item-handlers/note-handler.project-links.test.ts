/**
 * A synced note *update* must derive the note's project links from the
 * properties it just wrote into the file. The create path gets this for free
 * (`syncNoteToCache` publishes `note.upserted`); the update path publishes
 * nothing, so without an explicit reconcile the receiving device shows the chip
 * on the note and nothing in the project hub — and, worse, a later rename of
 * that project skips the note entirely, unlinking it on every device.
 *
 * These run against a real data DB so they assert the row, not a mock call.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { projectLinks } from '@memry/db-schema/schema/project-links'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-links-'))

let dataDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(() => undefined),
  getNoteCacheByPath: vi.fn(() => undefined),
  getNoteTags: vi.fn(() => []),
  setNoteTags: vi.fn(),
  updateNoteCache: vi.fn(),
  setNoteProperties: vi.fn()
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: VAULT_ROOT }))
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  syncFileToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))

vi.mock('../note-sync', () => ({
  extractFolderFromPath: vi.fn(() => null)
}))

vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

vi.mock('@memry/domain-notes', () => ({ saveCanonicalPropertyDefinition: vi.fn() }))

const mockSyncProjectUpdate = vi.fn()
vi.mock('../../tasks/runtime-effects', () => ({
  syncProjectUpdate: (...args: unknown[]) => mockSyncProjectUpdate(...args)
}))

import { noteHandler } from './note-handler'

const NOTE_PATH = path.join('n1.md')

function seedNote(): void {
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

  fs.mkdirSync(VAULT_ROOT, { recursive: true })
  fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), '---\ntags: []\n---\n\nbody\n', 'utf-8')
}

describe('noteHandler.applyUpsert — project links on a synced update', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    dataDb = createTestDataDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }

    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
    dataDb.db
      .insert(projects)
      .values({
        id: 'p1',
        name: 'Alpha',
        color: '#000',
        position: 0,
        isInbox: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        modifiedAt: '2026-01-01T00:00:00.000Z'
      })
      .run()
    seedNote()
  })

  afterEach(() => {
    dataDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it('links the note to the named project when a property-only update arrives for a note that already exists', () => {
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { properties: { project: ['Alpha'] }, clock: { 'device-A': 1, 'device-B': 1 } },
      { 'device-A': 1, 'device-B': 1 }
    )

    expect(result).toBe('applied')

    const links = dataDb.db.select().from(projectLinks).all()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ projectId: 'p1', itemId: 'n1', itemType: 'note' })
    // Exactly once per applied note — a second reconcile would push the project again.
    expect(mockSyncProjectUpdate).toHaveBeenCalledTimes(1)
    expect(mockSyncProjectUpdate).toHaveBeenCalledWith('p1', ['links'])
  })

  it('drops the link when the update clears the project property', () => {
    dataDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0 })
      .run()

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { properties: { project: [] }, clock: { 'device-A': 1, 'device-B': 1 } },
      { 'device-A': 1, 'device-B': 1 }
    )

    expect(dataDb.db.select().from(projectLinks).all()).toEqual([])
  })

  it('leaves links alone when the payload carries no properties at all (older client)', () => {
    dataDb.db
      .insert(projectLinks)
      .values({ id: 'l1', projectId: 'p1', itemType: 'note', itemId: 'n1', position: 0 })
      .run()

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'n1', clock: { 'device-A': 1, 'device-B': 1 } },
      { 'device-A': 1, 'device-B': 1 }
    )

    expect(dataDb.db.select().from(projectLinks).all()).toHaveLength(1)
    expect(mockSyncProjectUpdate).not.toHaveBeenCalled()
  })

  it('does not reconcile links for a non-markdown note', () => {
    dataDb.db.update(noteMetadata).set({ fileType: 'pdf' }).run()

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { properties: { project: ['Alpha'] }, clock: { 'device-A': 1, 'device-B': 1 } },
      { 'device-A': 1, 'device-B': 1 }
    )

    expect(dataDb.db.select().from(projectLinks).all()).toEqual([])
  })
})
