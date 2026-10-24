import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-aliases-sync-'))

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))
vi.mock('../../database/client', () => ({
  getDatabase: () => dataDb.db,
  getIndexDatabase: () => indexDb.db
}))
vi.mock('../../vault/note-snapshots', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-versions', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-crud', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes-io', async () => await import('../../vault/notes'))
vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))
vi.mock('../../vault/status', async () => await import('../../vault/index'))
vi.mock('../../vault/index', () => ({ getStatus: vi.fn(() => ({ path: VAULT_ROOT })) }))
vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  syncFileToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))
vi.mock('../note-sync', () => ({ extractFolderFromPath: vi.fn(() => null) }))
vi.mock('../crdt-network-update', async () => await import('../crdt-writeback'))
vi.mock('../crdt-writeback-port', async () => {
  const writeback = await import('../crdt-writeback')
  return { crdtWriteback: () => writeback }
})
vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))
vi.mock('@memry/domain-notes', () => ({ saveCanonicalPropertyDefinition: vi.fn() }))

import { noteHandler } from './note-handler'
import { buildNotePushPayload } from './note-handler-sync-helpers'
import { insertNoteCache, reindexNoteNames, resolveLinkTargets } from '@main/database/queries/notes'

const NOTE_PATH = 'n1.md'
const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

function seedNote(fileContent: string, aliases: string[]): void {
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
  insertNoteCache(indexDb.db, {
    id: 'n1',
    path: NOTE_PATH,
    title: 'n1',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z'
  })
  reindexNoteNames(indexDb.db, { noteId: 'n1', title: 'n1', aliases: { kind: 'read', aliases } })
  fs.mkdirSync(VAULT_ROOT, { recursive: true })
  fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), fileContent, 'utf-8')
}

const readNoteFile = (): string => fs.readFileSync(path.join(VAULT_ROOT, NOTE_PATH), 'utf-8')
const holderOf = (name: string): string | null =>
  resolveLinkTargets(indexDb.db, [name]).get(name)?.noteId ?? null

describe('note aliases over sync', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it.each([
    ['absent (an older build)', {}],
    ['null', { aliases: null }]
  ])('keeps the file and index aliases when the payload has them %s', (_label, field) => {
    const file = '---\naliases: K.\nstatus: draft\n---\nBody\n'
    seedNote(file, ['K.'])

    noteHandler.applyUpsert(ctx, 'n1', { ...field, clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(readNoteFile()).toContain('aliases: K.\n')
    expect(holderOf('k.')).toBe('n1')
  })

  it('replaces the list with a pulled array and indexes it', () => {
    seedNote('---\nstatus: draft\n---\nBody\n', [])

    noteHandler.applyUpsert(ctx, 'n1', { aliases: ['K.', 'KY'], clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(readNoteFile()).toBe('---\nstatus: draft\naliases:\n  - K.\n  - KY\n---\nBody\n')
    expect(holderOf('ky')).toBe('n1')
  })

  it('clears the list with a pulled []', () => {
    seedNote('---\naliases:\n  - K.\nstatus: draft\n---\nBody\n', ['K.'])

    noteHandler.applyUpsert(ctx, 'n1', { aliases: [], clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(readNoteFile()).toBe('---\nstatus: draft\n---\nBody\n')
    expect(holderOf('k.')).toBeNull()
  })

  it('applies aliases that arrive with a rename', () => {
    seedNote('---\nstatus: draft\n---\nBody\n', [])

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'Kaan', aliases: ['K.'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    expect(fs.readFileSync(path.join(VAULT_ROOT, 'Kaan.md'), 'utf-8')).toContain('aliases:\n  - K.')
    expect([holderOf('kaan'), holderOf('k.'), holderOf('n1')]).toEqual(['n1', 'n1', null])
  })

  it('pushes the list it reads, [] included, and the pull restores it', () => {
    seedNote('---\naliases: [K., KY]\n---\nBody\n', ['K.', 'KY'])
    const pushed = JSON.parse(buildNotePushPayload('n1', 'update') ?? 'null')
    expect(pushed.aliases).toEqual(['K.', 'KY'])

    fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), 'Body\n', 'utf-8')
    expect(JSON.parse(buildNotePushPayload('n1', 'update') ?? 'null').aliases).toEqual([])

    noteHandler.applyUpsert(ctx, 'n1', { ...pushed, clock: REMOTE_CLOCK }, REMOTE_CLOCK)
    expect(readNoteFile()).toContain('aliases:\n  - K.\n  - KY\n')
  })

  it('omits aliases from a push when the file cannot be read', () => {
    seedNote('Body\n', [])
    fs.rmSync(path.join(VAULT_ROOT, NOTE_PATH))

    expect(JSON.parse(buildNotePushPayload('n1', 'update') ?? 'null')).not.toHaveProperty('aliases')
  })
})
