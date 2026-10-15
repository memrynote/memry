/**
 * A remote metadata apply that rewrites a note's frontmatter writes the file
 * with the watcher told to ignore it, so nothing else re-reads those bytes.
 * The index hash has to move with them: the CRDT write-back compares it to
 * the file, and a stale hash makes the app's own write look like an outside
 * edit, deferring the write-back and logging it for every pulled note (#3282).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-content-hash-'))

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

import { noteHandler } from './note-handler'
import { getNoteCacheById, insertNoteCache, setNoteTags } from '@main/database/queries/notes'
import { generateContentHash } from '../../vault/frontmatter'

const NOTE_PATH = 'n1.md'
const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

function seedNote(fileContent: string, bodyTags: string[]): void {
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
    contentHash: 'hash-n1',
    wordCount: 0,
    characterCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z'
  })
  setNoteTags(indexDb.db, 'n1', { header: [], inline: bodyTags })

  fs.mkdirSync(VAULT_ROOT, { recursive: true })
  fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), fileContent, 'utf-8')
}

function readNoteFile(): string {
  return fs.readFileSync(path.join(VAULT_ROOT, NOTE_PATH), 'utf-8')
}

function cachedHash(): string | null | undefined {
  return getNoteCacheById(indexDb.db, 'n1')?.contentHash
}

describe('noteHandler.applyUpsert — index hash after a frontmatter rewrite', () => {
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

  it('moves the hash to the rewritten bytes in place', () => {
    seedNote('---\ntitle: n1\n---\n\nbody\n', [])

    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { tags: ['roadmap'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    expect(result).toBe('applied')
    expect(readNoteFile()).toMatch(/roadmap/)
    expect(cachedHash()).toBe(generateContentHash(readNoteFile()))
  })

  it('moves the hash to the rewritten bytes when the update also renames the file', () => {
    seedNote('---\ntitle: n1\n---\n\nbody\n', [])

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'renamed', tags: ['roadmap'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    const row = getNoteCacheById(indexDb.db, 'n1')
    const raw = fs.readFileSync(path.join(VAULT_ROOT, row?.path ?? ''), 'utf-8')
    expect(raw).toMatch(/roadmap/)
    expect(row?.contentHash).toBe(generateContentHash(raw))
  })

  it('keeps the hash when a pure rename leaves the bytes alone', () => {
    seedNote('---\ntitle: n1\n---\n\nbody\n', [])

    noteHandler.applyUpsert(ctx, 'n1', { title: 'renamed', clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(cachedHash()).toBe('hash-n1')
  })
})
