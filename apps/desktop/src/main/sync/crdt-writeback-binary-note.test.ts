import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getNoteMetadataById } from '@memry/storage-data'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type * as NoteQueries from '@main/database/queries/notes'

/**
 * A fresh device applies a binary note's record (an image, a PDF, a recording)
 * through `syncFileToCache`, and the pack phase seeded a doc for the same id:
 * the server holds a CRDT body for every note, binary ones included. Settling
 * that doc (`CrdtProvider.materialize` -> `writebackNow`) reaches the write-back
 * while the note's index row is still on its way through the projection lane,
 * so the write-back reads the canonical row. Run for real here: the data DB,
 * `note-sync`'s canonical upsert and the vault files on a temp dir (#5412).
 */

const mocks = vi.hoisted(() => ({
  dataDb: null as unknown,
  vaultRoot: '',
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../lib/logger', () => ({ createLogger: () => mocks.log }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, close: vi.fn(), purge: vi.fn() })
}))
vi.mock('./blocknote-converter', () => ({
  setVaultEmbedResolver: () => {},
  yDocToMarkdown: async (doc: Y.Doc) => doc.getText('body').toJSON(),
  findUnrepresentableNodes: () => []
}))
vi.mock('../database/client', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => ({ kind: 'index-db' }),
  isIndexDatabaseInitialized: () => false
}))
// The index row has not been projected yet: the projection lane runs behind
// the canonical write.
vi.mock('@main/database/queries/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof NoteQueries>()),
  getNoteCacheById: () => undefined,
  getNoteCacheByPath: () => undefined,
  updateNoteCache: vi.fn()
}))
vi.mock('../projections', () => ({
  publishProjectionEvent: vi.fn(),
  flushProjectionEvents: vi.fn(async () => {})
}))
vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => mocks.vaultRoot,
  toRelativePath: (absolute: string) => path.relative(mocks.vaultRoot, absolute),
  toAbsolutePath: (relative: string) => path.join(mocks.vaultRoot, relative),
  maybeCreateSignificantSnapshot: () => null,
  createSnapshot: () => null
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: () => ({}) }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(async () => {}),
  clearNoteDateReminders: vi.fn(async () => {})
}))

import { syncFileToCache } from '../vault/note-sync'
import { resetWritebackState, writebackNow } from './crdt-writeback'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

const CASES = [
  { fileType: 'image', mimeType: 'image/png', rel: 'photos/Sunset.png' },
  { fileType: 'pdf', mimeType: 'application/pdf', rel: 'papers/Report.pdf' },
  { fileType: 'audio', mimeType: 'audio/mp4', rel: 'audio/Memo.m4a' }
] as const

function packedDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, 'a body the server holds for this note')
  return doc
}

describe('write-back of a binary note whose index row is not projected yet (#5412)', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDataDb()
    mocks.dataDb = testDb.db
    mocks.vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-5412-'))
    resetWritebackState()
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
  })

  const applyBinaryRecord = (id: string, c: (typeof CASES)[number]) =>
    syncFileToCache({} as never, {
      id,
      path: c.rel,
      title: path.parse(c.rel).name,
      fileType: c.fileType,
      mimeType: c.mimeType,
      fileSize: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      modifiedAt: new Date('2026-01-01T00:00:00.000Z')
    })

  it.each(CASES)('keeps a $fileType note $fileType before its file downloads', async (c) => {
    applyBinaryRecord('bin-1', c)

    await writebackNow('bin-1', packedDoc())

    const row = getNoteMetadataById(testDb.db as never, 'bin-1')
    expect(row?.fileType).toBe(c.fileType)
    expect(row?.mimeType).toBe(c.mimeType)
    expect(row?.path).toBe(c.rel)
    // The attachment download owns this path; nothing else may put bytes there.
    expect(fs.existsSync(path.join(mocks.vaultRoot, c.rel))).toBe(false)
  })

  it('never writes markdown over a downloaded binary file', async () => {
    const c = CASES[0]
    applyBinaryRecord('bin-2', c)
    const abs = path.join(mocks.vaultRoot, c.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, PNG_BYTES)

    await writebackNow('bin-2', packedDoc())

    expect(fs.readFileSync(abs).equals(PNG_BYTES)).toBe(true)
    const row = getNoteMetadataById(testDb.db as never, 'bin-2')
    expect(row?.fileType).toBe('image')
    expect(row?.mimeType).toBe('image/png')
  })
})
