import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getNoteMetadataById, upsertNoteMetadata } from '@memry/storage-data'
import { insertNoteCache, getNoteCacheById } from '@main/database/queries/notes'
import type { IndexDb } from '@main/database/types'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  index: undefined as unknown
}))

vi.mock('../database', () => ({
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))

import { recordUploadedAttachment, recordDownloadedFileSize } from './note-attachment-metadata'

let dataDb: TestDataDb
let indexResult: TestDatabaseResult
let indexDb: IndexDb

const NOW = '2026-08-05T10:00:00.000Z'

function seedDataRow(
  id: string,
  overrides: Partial<Parameters<typeof upsertNoteMetadata>[1]> = {}
): void {
  upsertNoteMetadata(dataDb, {
    id,
    // Vault-relative, forward-slashed — this is the cross-platform contract for
    // the `path` column and nothing in this module may rewrite it.
    path: `notes/${id}.md`,
    title: id,
    fileType: 'markdown',
    createdAt: NOW,
    modifiedAt: NOW,
    ...overrides
  })
}

function seedIndexRow(id: string): void {
  insertNoteCache(indexDb, {
    id,
    path: `notes/${id}.md`,
    title: id,
    createdAt: NOW,
    modifiedAt: NOW
  })
}

beforeEach(() => {
  dataDb = createTestDataDb()
  indexResult = createTestIndexDb()
  indexDb = indexResult.db as unknown as IndexDb
  state.data = dataDb
  state.index = indexDb
})

afterEach(() => {
  indexResult.close()
})

describe('recordUploadedAttachment', () => {
  it('writes the attachment id into both the data DB and the index cache', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')

    const meta = getNoteMetadataById(dataDb, 'note-1')
    expect(meta?.attachmentId).toBe('att-1')
    expect(meta?.attachmentReferences).toEqual(['att-1'])
    // The index cache is what the note list renders from; the data DB is what
    // the sync push payload is built from. Both have to move together.
    expect(getNoteCacheById(indexDb, 'note-1')?.attachmentId).toBe('att-1')
  })

  it('merges additional attachments instead of replacing the list', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')
    recordUploadedAttachment('note-1', 'att-2')
    recordUploadedAttachment('note-1', 'att-3')

    // A note can embed several images and each upload lands here separately —
    // replacing the list dropped every id but the last, which is exactly "some
    // images never arrive on the other device".
    expect(getNoteMetadataById(dataDb, 'note-1')?.attachmentReferences).toEqual([
      'att-1',
      'att-2',
      'att-3'
    ])
  })

  it('does not duplicate an attachment id that is already recorded', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')
    recordUploadedAttachment('note-1', 'att-1')

    expect(getNoteMetadataById(dataDb, 'note-1')?.attachmentReferences).toEqual(['att-1'])
  })

  it('preserves references that arrived from another device', () => {
    // Refs pulled from a peer, merged in by the note handler before this
    // device uploads one of its own.
    seedDataRow('note-1', { attachmentReferences: ['att-from-mac', 'att-from-linux'] })
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-local')

    expect(getNoteMetadataById(dataDb, 'note-1')?.attachmentReferences).toEqual([
      'att-from-mac',
      'att-from-linux',
      'att-local'
    ])
  })

  it('always overwrites attachmentId with the newest upload while the list accumulates', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')
    recordUploadedAttachment('note-1', 'att-2')

    const meta = getNoteMetadataById(dataDb, 'note-1')
    expect(meta?.attachmentId).toBe('att-2')
    expect(meta?.attachmentReferences).toEqual(['att-1', 'att-2'])
    expect(getNoteCacheById(indexDb, 'note-1')?.attachmentId).toBe('att-2')
  })

  it('touches nothing except the attachment columns — path stays vault-relative', () => {
    seedDataRow('note-1', { emoji: '📝', fileSize: 42, mimeType: 'text/markdown' })
    seedIndexRow('note-1')
    const before = getNoteMetadataById(dataDb, 'note-1')

    recordUploadedAttachment('note-1', 'att-1')

    const after = getNoteMetadataById(dataDb, 'note-1')
    // The `path` column is the one cross-platform hazard on this row. This
    // module must never rewrite it — it takes no path argument at all.
    expect(after?.path).toBe('notes/note-1.md')
    expect(after?.path).toBe(before?.path)
    expect(after?.title).toBe(before?.title)
    expect(after?.emoji).toBe(before?.emoji)
    expect(after?.fileSize).toBe(before?.fileSize)
    expect(after?.mimeType).toBe(before?.mimeType)
    expect(after?.fileType).toBe(before?.fileType)
    expect(after?.localOnly).toBe(before?.localOnly)
    expect(after?.clock).toEqual(before?.clock)
    expect(getNoteCacheById(indexDb, 'note-1')?.path).toBe('notes/note-1.md')
  })

  it('stores no filesystem path — every value it writes is an opaque blob id', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-9f2c')

    const meta = getNoteMetadataById(dataDb, 'note-1')
    const written = [meta?.attachmentId ?? '', ...(meta?.attachmentReferences ?? [])]
    for (const value of written) {
      // No drive letter, no backslash separator, no POSIX absolute path — none
      // of which would survive a macOS ↔ Linux ↔ Windows round trip.
      expect(value).not.toMatch(/^[A-Za-z]:/)
      expect(value).not.toContain('\\')
      expect(value.startsWith('/')).toBe(false)
      expect(value).not.toContain('/Users/')
      expect(value).not.toContain('/home/')
    }
  })

  it('round-trips ids through the JSON column byte-for-byte', () => {
    seedDataRow('note-1')
    seedIndexRow('note-1')

    // Deliberately awkward ids: the column is JSON-encoded, so anything the
    // encoder mangles would silently break the reference on the far device.
    const ids = ['att-1', 'ATT-UPPER', 'att_with-dash.and.dot', 'att-üñïçø∂é', 'att 1']
    for (const id of ids) {
      recordUploadedAttachment('note-1', id)
    }

    const refs = getNoteMetadataById(dataDb, 'note-1')?.attachmentReferences
    expect(refs).toEqual(ids)
    expect(refs?.every((ref, i) => ref === ids[i])).toBe(true)
  })

  it('is a silent no-op for a note that exists in neither store', () => {
    expect(() => recordUploadedAttachment('ghost', 'att-1')).not.toThrow()

    // No row is created, and the caller (the upload success path in
    // ipc/sync-attachment-handlers.ts) gets no signal that the reference was
    // discarded.
    expect(getNoteMetadataById(dataDb, 'ghost')).toBeUndefined()
    expect(getNoteCacheById(indexDb, 'ghost')).toBeUndefined()
  })

  it('writes the index cache even when the data DB has no row for the note', () => {
    // Realistic: the index DB is a rebuildable cache and the data DB is the
    // sidecar sync store. They are separate SQLite files with separate
    // migrations and there is no transaction spanning them.
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')

    expect(getNoteCacheById(indexDb, 'note-1')?.attachmentId).toBe('att-1')
  })

  it.fails('BUG: a data-DB miss silently loses the reference the index cache just accepted', () => {
    seedIndexRow('note-1')

    recordUploadedAttachment('note-1', 'att-1')

    // `buildNotePushPayload` (item-handlers/note-handler-sync-helpers.ts)
    // reads `attachmentReferences` from the DATA DB. With the index cache
    // written and the data DB not, this device shows the image locally and
    // never tells any peer it exists — "images inside notes never arrive",
    // and re-adding the image walks the same path again. The two writes are
    // not atomic and the failed one is neither retried nor logged.
    expect(getNoteMetadataById(dataDb, 'note-1')?.attachmentReferences).toEqual(['att-1'])
  })
})

describe('recordDownloadedFileSize', () => {
  it('writes the size into both the data DB and the index cache', () => {
    seedDataRow('note-1', { fileType: 'pdf', fileSize: 0 })
    seedIndexRow('note-1')

    recordDownloadedFileSize('note-1', 20_481)

    expect(getNoteMetadataById(dataDb, 'note-1')?.fileSize).toBe(20_481)
    expect(getNoteCacheById(indexDb, 'note-1')?.fileSize).toBe(20_481)
  })

  it('stores a zero-byte size as 0, not null', () => {
    seedDataRow('note-1', { fileType: 'pdf', fileSize: 99 })
    seedIndexRow('note-1')

    recordDownloadedFileSize('note-1', 0)

    expect(getNoteMetadataById(dataDb, 'note-1')?.fileSize).toBe(0)
    expect(getNoteCacheById(indexDb, 'note-1')?.fileSize).toBe(0)
  })

  it('leaves the attachment references alone', () => {
    seedDataRow('note-1', { attachmentReferences: ['att-1'], attachmentId: 'att-1' })
    seedIndexRow('note-1')

    recordDownloadedFileSize('note-1', 512)

    const meta = getNoteMetadataById(dataDb, 'note-1')
    expect(meta?.attachmentReferences).toEqual(['att-1'])
    expect(meta?.attachmentId).toBe('att-1')
    expect(meta?.path).toBe('notes/note-1.md')
  })

  it('is a silent no-op for an unknown note', () => {
    expect(() => recordDownloadedFileSize('ghost', 512)).not.toThrow()
    expect(getNoteMetadataById(dataDb, 'ghost')).toBeUndefined()
  })
})
