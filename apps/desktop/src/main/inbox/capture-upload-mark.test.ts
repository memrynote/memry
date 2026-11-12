/**
 * A capture that stores a file marks it for upload in the write that creates
 * the item (#4157), on a real data DB. Covers the voice recorder and the
 * image/PDF path every other file capture (drop, paste, extension PDF) shares.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxAttachmentUploads } from '@memry/db-schema/schema/inbox'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

const attachments = vi.hoisted(() => ({ store: vi.fn() }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), requireDatabase: vi.fn() }))
vi.mock('./attachments', () => ({
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png'],
  ALLOWED_AUDIO_TYPES: ['audio/webm'],
  ALLOWED_VIDEO_TYPES: ['video/mp4'],
  ALLOWED_DOCUMENT_TYPES: ['application/pdf'],
  resolveAttachmentUrl: (value: string | null) => (value ? `memry-file://${value}` : null),
  resolveInboxAttachmentFilePath: (value: string) => `/vault/${value}`,
  storeInboxAttachment: attachments.store,
  storeThumbnail: vi.fn()
}))
vi.mock('../image-processing/bridge', () => ({
  processInboxImageAttachment: vi.fn(async () => null)
}))
vi.mock('./transcription', () => ({
  getVoiceRecordingReadiness: vi.fn(async () => ({ ready: true, provider: 'local' }))
}))
vi.mock('./jobs', () => ({
  queueInboxTranscriptionJob: vi.fn(),
  markInboxJobFailed: vi.fn(),
  queueInboxMetadataJob: vi.fn(),
  resumeInboxJobs: vi.fn(),
  teardownInboxJobScheduler: vi.fn()
}))
vi.mock('./duplicates', () => ({
  findDuplicateByContent: vi.fn(() => null),
  findDuplicateByUrl: vi.fn(() => null)
}))
vi.mock('./runtime-effects', () => ({
  publishInboxUpserted: vi.fn(),
  syncInboxCreate: vi.fn(),
  syncInboxUpdate: vi.fn()
}))
vi.mock('./stats', () => ({ isStale: vi.fn(() => false) }))
vi.mock('./suggestions', () => ({
  getSuggestions: vi.fn().mockResolvedValue([]),
  trackSuggestionFeedback: vi.fn()
}))

import { requireDatabase } from '../database'
import { captureVoice } from './capture'
import { createDesktopInboxDomain, insertItemWithTags } from './domain'

let testDb: TestDatabaseResult

const pendingIds = () =>
  testDb.db
    .select()
    .from(inboxAttachmentUploads)
    .all()
    .map((row) => row.itemId)

beforeEach(() => {
  testDb = createTestDataDb()
  vi.mocked(requireDatabase).mockReturnValue(asClientDb(testDb.db))
  attachments.store.mockReset().mockImplementation(async (id: string, _data, filename: string) => ({
    success: true,
    path: `attachments/inbox/${id}/${filename}`
  }))
})

describe('marking a capture file for upload', () => {
  it('marks a voice recording', async () => {
    const response = await captureVoice({
      data: Buffer.from('audio'),
      duration: 10,
      format: 'webm',
      transcribe: false
    })

    expect(response.success).toBe(true)
    expect(pendingIds()).toEqual([response.item!.id])
  })

  it('marks an image and a PDF capture', async () => {
    const domain = createDesktopInboxDomain()

    const image = await domain.captureImage({
      data: Buffer.from([1, 2, 3]),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg'
    })
    const pdf = await domain.captureImage({
      data: Buffer.from([5, 6, 7]),
      filename: 'brief.pdf',
      mimeType: 'application/pdf'
    })

    expect(pendingIds().toSorted()).toEqual([image.item!.id, pdf.item!.id].toSorted())
  })

  it('marks nothing for a text capture, a local-only item, or an insert that fails', () => {
    const db = asClientDb(testDb.db)
    insertItemWithTags(db, { id: 'text', type: 'note', title: 'Text' }, undefined)
    insertItemWithTags(
      db,
      { id: 'local', type: 'image', title: 'Local', attachmentPath: 'a/b.png', localOnly: true },
      undefined
    )
    expect(() =>
      insertItemWithTags(
        db,
        { id: 'text', type: 'image', title: 'Dup', attachmentPath: 'a/c.png' },
        undefined
      )
    ).toThrow('UNIQUE constraint failed')

    expect(pendingIds()).toEqual([])
  })
})
