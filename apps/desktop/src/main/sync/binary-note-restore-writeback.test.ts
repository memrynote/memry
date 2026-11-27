import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertNoteMetadata } from '@memry/storage-data'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  markDownloadSucceeded,
  resetAttachmentDownloadSession
} from '@memry/sync-client/attachment-download-state'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type * as NoteQueries from '@main/database/queries/notes'

/**
 * A shipped build's write-back put markdown over a binary note's PNG and saved
 * its row as markdown (#5412). The restore downloads the PNG back while the
 * row still says markdown; a remote CRDT update for the note then reaches the
 * real write-back, which must leave the restored file and the doc alone
 * (#5415). Run for real: the data DB, the write-back and vault files on a temp
 * dir.
 */

const mocks = vi.hoisted(() => ({
  dataDb: null as unknown,
  vaultRoot: '',
  feed: vi.fn(async () => true),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../lib/logger', () => ({ createLogger: () => mocks.log }))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), isDatabaseInitialized: () => false }))
vi.mock('../store', () => ({ getCurrentVaultPath: () => null }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, close: vi.fn(), purge: vi.fn() })
}))
vi.mock('./crdt-external-feed', () => ({ feedExternalEditToCrdt: mocks.feed }))
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

import { restoreOverwrittenBinaryNotesWith } from './binary-note-restore'
import { resetWritebackState, writebackNow } from './crdt-writeback'

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
])
const WRITEBACK_MARKDOWN = 'a body the server holds for this note\n'

describe('write-back after a binary note restore (#5415)', () => {
  let testDb: TestDatabaseResult
  const downloader = (event: {
    noteId: string
    attachmentId: string
    diskPath: string
    landed?: (outlived: () => boolean) => void
  }): void => {
    fs.writeFileSync(`${event.diskPath}.part`, PNG)
    fs.renameSync(`${event.diskPath}.part`, event.diskPath)
    markDownloadSucceeded(asClientDb(testDb.db), event.noteId, event.attachmentId)
    event.landed?.(() => false)
  }

  beforeEach(() => {
    testDb = createTestDataDb()
    mocks.dataDb = testDb.db
    mocks.vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-5415-'))
    mocks.feed.mockClear()
    resetWritebackState()
    attachmentEvents.onDownloadNeeded(downloader)
  })

  afterEach(() => {
    attachmentEvents.offDownloadNeeded(downloader)
    resetAttachmentDownloadSession()
    testDb.close()
    fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
  })

  it('keeps a restored PNG whose row still says markdown through a remote update', async () => {
    const abs = path.join(mocks.vaultRoot, 'Sunset.png')
    fs.writeFileSync(abs, WRITEBACK_MARKDOWN)
    upsertNoteMetadata(asClientDb(testDb.db), {
      id: 'bin-1',
      path: 'Sunset.png',
      title: 'Sunset',
      fileType: 'markdown',
      attachmentId: 'att-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      modifiedAt: '2026-09-01T00:00:00.000Z'
    })
    const doc = new Y.Doc()
    doc.getText('body').insert(0, WRITEBACK_MARKDOWN)

    await restoreOverwrittenBinaryNotesWith({
      db: asClientDb(testDb.db),
      vaultPath: mocks.vaultRoot
    })
    expect(fs.readFileSync(abs)).toEqual(PNG)

    // A peer's edit to the note's CRDT body arrives and is settled.
    doc.getText('body').insert(0, 'remote ')
    await writebackNow('bin-1', doc)

    expect(fs.readFileSync(abs)).toEqual(PNG)
    expect(mocks.feed).not.toHaveBeenCalled()
    expect(doc.getText('body').toJSON()).toBe(`remote ${WRITEBACK_MARKDOWN}`)
  })
})
