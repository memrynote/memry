import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupTestDatabase,
  createTestDatabase,
  seedInboxItem,
  type TestDatabaseResult
} from '../../../tests/utils/test-db'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { eq } from 'drizzle-orm'

const mockSend = vi.fn()
const mockStoreInboxAttachment = vi.fn()
const mockStoreThumbnail = vi.fn()
const mockCaptureVoice = vi.fn()
const mockQueueMetadataJob = vi.fn()
const mockQueueTranscriptionJob = vi.fn()
const mockPublishInboxUpserted = vi.fn()
const mockSyncInboxCreate = vi.fn()
const mockExtractSocialPost = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({
      width: 640,
      height: 480,
      format: 'jpeg',
      exif: Buffer.from([1])
    }),
    clone: vi.fn(() => ({
      resize: vi.fn(() => ({
        jpeg: vi.fn(() => ({
          toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb'))
        }))
      }))
    }))
  }))
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('./attachments', () => ({
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png'],
  ALLOWED_AUDIO_TYPES: ['audio/webm'],
  ALLOWED_VIDEO_TYPES: ['video/mp4'],
  ALLOWED_DOCUMENT_TYPES: ['application/pdf'],
  resolveAttachmentUrl: (path: string | null) => (path ? `memry-file://${path}` : null),
  storeInboxAttachment: (...args: unknown[]) => mockStoreInboxAttachment(...args),
  storeThumbnail: (...args: unknown[]) => mockStoreThumbnail(...args)
}))

vi.mock('./capture', () => ({
  captureVoice: (...args: unknown[]) => mockCaptureVoice(...args)
}))

vi.mock('./duplicates', () => ({
  findDuplicateByContent: vi.fn(() => null),
  findDuplicateByUrl: vi.fn(() => null)
}))

vi.mock('./jobs', () => ({
  queueInboxMetadataJob: (...args: unknown[]) => mockQueueMetadataJob(...args),
  queueInboxTranscriptionJob: (...args: unknown[]) => mockQueueTranscriptionJob(...args),
  resumeInboxJobs: vi.fn(),
  teardownInboxJobScheduler: vi.fn()
}))

vi.mock('./metadata', () => ({
  titleFromUrl: (url: string) => `Title for ${url}`
}))

vi.mock('./runtime-effects', () => ({
  publishInboxUpserted: (...args: unknown[]) => mockPublishInboxUpserted(...args),
  syncInboxCreate: (...args: unknown[]) => mockSyncInboxCreate(...args),
  syncInboxUpdate: vi.fn()
}))

vi.mock('./social', () => ({
  detectSocialPlatform: (url: string) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      return hostname === 'x.com' || hostname.endsWith('.x.com') ? 'twitter' : null
    } catch {
      return null
    }
  },
  extractSocialPost: (...args: unknown[]) => mockExtractSocialPost(...args),
  isSocialPost: (url: string) => url.includes('x.com')
}))

vi.mock('./stats', () => ({
  isStale: vi.fn(() => false)
}))

vi.mock('./suggestions', () => ({
  getSuggestions: vi.fn().mockResolvedValue([]),
  trackSuggestionFeedback: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { requireDatabase, getDatabase } from '../database'
import { createDesktopInboxDomain } from './domain'

describe('createDesktopInboxDomain', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(requireDatabase).mockReturnValue(testDb.db)
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    mockSend.mockClear()
    mockStoreInboxAttachment
      .mockReset()
      .mockResolvedValue({ success: true, path: 'inbox/file.bin' })
    mockStoreThumbnail
      .mockReset()
      .mockResolvedValue({ success: true, thumbnailPath: 'inbox/thumb.jpg' })
    mockCaptureVoice.mockReset().mockResolvedValue({
      success: true,
      item: {
        id: 'voice-1',
        type: 'voice',
        title: 'Voice memo'
      }
    })
    mockQueueMetadataJob.mockReset()
    mockQueueTranscriptionJob.mockReset()
    mockPublishInboxUpserted.mockReset()
    mockSyncInboxCreate.mockReset()
    mockExtractSocialPost.mockReset().mockReturnValue({
      success: true,
      metadata: { authorHandle: '@memry', text: 'launch' }
    })
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
  })

  it('captures text items with tags, emits events, and syncs the new inbox item', async () => {
    const domain = createDesktopInboxDomain()

    const result = await domain.captureText({
      content: 'A note captured from the tray',
      tags: ['inbox', 'tray'],
      source: 'quick-capture'
    })

    expect(result.success).toBe(true)
    expect(result.item).toEqual(
      expect.objectContaining({
        type: 'note',
        title: 'A note captured from the tray',
        tags: ['inbox', 'tray'],
        captureSource: 'quick-capture'
      })
    )
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining('captured'),
      expect.objectContaining({ item: expect.objectContaining({ type: 'note' }) })
    )
    expect(mockSyncInboxCreate).toHaveBeenCalledWith(result.item?.id)
  })

  it('captures normal and social links with metadata jobs or inline social metadata', async () => {
    const domain = createDesktopInboxDomain()

    const linkResult = await domain.captureLink({
      url: 'https://example.com/read',
      tags: ['read']
    })

    expect(linkResult.success).toBe(true)
    expect(linkResult.item).toEqual(
      expect.objectContaining({
        type: 'link',
        title: 'Title for https://example.com/read',
        sourceUrl: 'https://example.com/read'
      })
    )
    expect(mockQueueMetadataJob).toHaveBeenCalledWith(
      linkResult.item?.id,
      'https://example.com/read'
    )

    const socialResult = await domain.captureLink({
      url: 'https://x.com/memry/status/1'
    })

    expect(socialResult.success).toBe(true)
    expect(socialResult.item).toEqual(expect.objectContaining({ type: 'social' }))
    expect(mockExtractSocialPost).toHaveBeenCalledWith('https://x.com/memry/status/1')
    expect(mockPublishInboxUpserted).toHaveBeenCalledWith(socialResult.item?.id)
    expect(mockSend).toHaveBeenCalledWith(
      expect.stringContaining('metadata-complete'),
      expect.objectContaining({ id: socialResult.item?.id })
    )
  })

  it('captures image and document binaries, including thumbnail metadata for images', async () => {
    const domain = createDesktopInboxDomain()

    const imageResult = await domain.captureImage({
      data: Buffer.from([1, 2, 3]),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      tags: ['media']
    })

    expect(imageResult.success).toBe(true)
    expect(imageResult.item).toEqual(
      expect.objectContaining({
        type: 'image',
        title: 'photo',
        attachmentUrl: 'memry-file://inbox/file.bin',
        thumbnailUrl: 'memry-file://inbox/thumb.jpg',
        tags: ['media']
      })
    )
    expect(mockStoreThumbnail).toHaveBeenCalledWith(
      imageResult.item?.id,
      Buffer.from('thumb'),
      'jpg'
    )

    const pdfResult = await domain.captureImage({
      data: { type: 'Buffer', data: [5, 6, 7] },
      filename: 'brief.pdf',
      mimeType: 'application/pdf'
    })

    expect(pdfResult.success).toBe(true)
    expect(pdfResult.item).toEqual(expect.objectContaining({ type: 'pdf', title: 'brief' }))

    await expect(
      domain.captureImage({
        data: Buffer.alloc(0),
        filename: 'empty.jpg',
        mimeType: 'image/jpeg'
      })
    ).resolves.toMatchObject({ success: false, error: 'Empty file data' })
  })

  it('captures web clips with source metadata for browser extension quotes', async () => {
    const domain = createDesktopInboxDomain()

    const result = await domain.captureClip({
      html: '<p>quoted text</p>',
      text: 'quoted text',
      sourceUrl: 'https://example.com/article',
      sourceTitle: 'Example Article',
      source: 'browser-extension',
      tags: ['quote']
    })

    expect(result.success).toBe(true)
    expect(result.item).toEqual(
      expect.objectContaining({
        type: 'clip',
        title: 'Example Article',
        content: 'quoted text',
        sourceUrl: 'https://example.com/article',
        sourceTitle: 'Example Article',
        captureSource: 'browser-extension',
        tags: ['quote'],
        metadata: expect.objectContaining({
          quotedText: 'quoted text',
          hasFormatting: true
        })
      })
    )
    expect(mockSyncInboxCreate).toHaveBeenCalledWith(result.item?.id)
  })

  it('captures pdf binaries through the pdf command', async () => {
    const domain = createDesktopInboxDomain()

    const result = await domain.capturePdf({
      data: Buffer.from('%PDF'),
      filename: 'paper.pdf',
      source: 'browser-extension'
    })

    expect(result.success).toBe(true)
    expect(result.item).toEqual(
      expect.objectContaining({
        type: 'pdf',
        title: 'paper',
        captureSource: 'browser-extension'
      })
    )
    expect(mockStoreInboxAttachment).toHaveBeenCalledWith(
      result.item?.id,
      Buffer.from('%PDF'),
      'paper.pdf',
      'application/pdf'
    )
  })

  it('normalizes voice memo data and delegates capture to the voice pipeline', async () => {
    const domain = createDesktopInboxDomain()

    await expect(
      domain.captureVoice({
        data: { 0: 1, 1: 2 },
        duration: 12,
        format: 'webm',
        transcribe: true,
        tags: ['voice']
      })
    ).resolves.toMatchObject({ success: true })

    expect(mockCaptureVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        data: Buffer.from([1, 2]),
        duration: 12,
        format: 'webm',
        transcribe: true,
        tags: ['voice']
      })
    )

    await expect(
      domain.captureVoice({
        data: {},
        duration: 0,
        format: 'webm'
      })
    ).resolves.toMatchObject({ success: false, error: 'Invalid audio data format' })
  })

  it('marks retry state and queues retry work for voice transcription and link metadata', async () => {
    const domain = createDesktopInboxDomain()
    const voiceId = seedInboxItem(testDb.db, {
      id: 'voice-retry',
      type: 'voice',
      title: 'Retry voice',
      transcriptionStatus: 'failed'
    })
    const linkId = seedInboxItem(testDb.db, {
      id: 'link-retry',
      type: 'link',
      title: 'Retry link',
      processingStatus: 'error'
    })
    testDb.db
      .update(inboxItems)
      .set({ attachmentPath: 'audio.webm' })
      .where(eq(inboxItems.id, voiceId))
      .run()
    testDb.db
      .update(inboxItems)
      .set({ sourceUrl: 'https://example.com/retry' })
      .where(eq(inboxItems.id, linkId))
      .run()

    await expect(domain.retryTranscription(voiceId)).resolves.toEqual({ success: true })
    expect(mockQueueTranscriptionJob).toHaveBeenCalledWith(voiceId, 'audio.webm')

    await expect(domain.retryMetadata(linkId)).resolves.toEqual({ success: true })
    expect(mockQueueMetadataJob).toHaveBeenCalledWith(linkId, 'https://example.com/retry')

    await expect(domain.retryMetadata(voiceId)).resolves.toMatchObject({
      success: false,
      error: 'Item is not a link'
    })
  })
})
