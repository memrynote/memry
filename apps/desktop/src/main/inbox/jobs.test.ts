import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { inboxItems, inboxJobs } from '@memry/db-schema/schema/inbox'
import {
  cleanupTestDatabase,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const mockFetchUrlMetadata = vi.hoisted(() => vi.fn())
const mockDownloadImage = vi.hoisted(() => vi.fn())
const mockTranscribeAudio = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('./metadata', () => ({
  fetchUrlMetadata: mockFetchUrlMetadata,
  downloadImage: mockDownloadImage
}))

vi.mock('./metadata-utils', () => ({
  isBotPageTitle: vi.fn(() => false),
  titleFromUrl: vi.fn((url: string) => url)
}))

vi.mock('./attachments', () => ({
  getItemAttachmentsDir: vi.fn(() => '/tmp/inbox-item')
}))

vi.mock('./transcription', () => ({
  transcribeAudio: mockTranscribeAudio
}))

import { getDatabase, requireDatabase } from '../database'
import {
  hasPendingInboxJobs,
  listInboxJobs,
  markInboxJobFailed,
  queueInboxMetadataJob,
  queueInboxTranscriptionJob,
  resumeInboxJobs,
  teardownInboxJobScheduler
} from './jobs'

describe('inbox jobs', () => {
  let testDb: TestDatabaseResult
  let window: {
    isDestroyed: () => boolean
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'))

    testDb = createTestDataDb()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    vi.mocked(requireDatabase).mockReturnValue(testDb.db)

    window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window] as never)

    mockFetchUrlMetadata.mockReset().mockResolvedValue({
      title: 'Resolved title',
      description: 'Resolved description'
    })
    mockDownloadImage.mockReset().mockResolvedValue(null)
    mockTranscribeAudio.mockReset()
  })

  afterEach(() => {
    teardownInboxJobScheduler()
    cleanupTestDatabase(testDb)
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('resumes running metadata jobs after restart and completes them', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'item-1',
        type: 'link',
        title: 'https://example.com',
        content: null,
        sourceUrl: 'https://example.com',
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()

    testDb.db
      .insert(inboxJobs)
      .values({
        id: 'job-1',
        itemId: 'item-1',
        type: 'metadata-scrape',
        status: 'running',
        runAt: now,
        attempts: 0,
        maxAttempts: 2,
        payload: { url: 'https://example.com' },
        createdAt: now,
        updatedAt: now
      })
      .run()

    resumeInboxJobs()
    await vi.runAllTimersAsync()
    await vi.dynamicImportSettled()

    const item = testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'item-1')).get()
    const job = testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, 'job-1')).get()

    expect(item?.processingStatus).toBe('complete')
    expect(item?.title).toBe('Resolved title')
    expect(job?.status).toBe('complete')
    expect(window.webContents.send).toHaveBeenCalled()
  })

  it('queues metadata jobs, upserts existing rows, filters listings, and detects due work', () => {
    const future = '2026-05-10T00:01:00.000Z'
    const now = new Date().toISOString()

    for (const [id, sourceUrl] of [
      ['item-queued', 'https://example.com/a'],
      ['item-due', 'https://example.com/due'],
      ['item-failed', 'https://example.com/fail']
    ] as const) {
      testDb.db
        .insert(inboxItems)
        .values({
          id,
          type: 'link',
          title: sourceUrl,
          content: null,
          sourceUrl,
          createdAt: now,
          modifiedAt: now,
          processingStatus: 'pending'
        })
        .run()
    }

    const firstId = queueInboxMetadataJob('item-queued', 'https://example.com/a', {
      maxAttempts: 3,
      runAt: future
    })
    const secondId = queueInboxMetadataJob('item-queued', 'https://example.com/b', {
      maxAttempts: 2,
      runAt: future
    })

    expect(secondId).toBe(firstId)

    const queued = testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, firstId)).get()
    expect(queued).toMatchObject({
      itemId: 'item-queued',
      type: 'metadata-scrape',
      status: 'pending',
      attempts: 0,
      maxAttempts: 2,
      payload: { url: 'https://example.com/b' }
    })

    expect(hasPendingInboxJobs()).toBe(false)

    queueInboxMetadataJob('item-due', 'https://example.com/due', {
      runAt: '2026-05-09T23:59:00.000Z'
    })
    expect(hasPendingInboxJobs()).toBe(true)

    const itemJobs = listInboxJobs({ itemIds: ['item-queued'] })
    expect(itemJobs).toHaveLength(1)
    expect(itemJobs[0]).toMatchObject({
      id: firstId,
      itemId: 'item-queued',
      type: 'metadata-scrape',
      status: 'pending',
      maxAttempts: 2
    })
    expect(itemJobs[0].runAt).toBeInstanceOf(Date)

    const failedId = markInboxJobFailed(
      'item-failed',
      'metadata-scrape',
      { url: 'https://example.com/fail' },
      'manual failure'
    )
    expect(listInboxJobs({ statuses: ['failed'] })).toEqual([
      expect.objectContaining({
        id: failedId,
        itemId: 'item-failed',
        status: 'failed',
        lastError: 'manual failure'
      })
    ])
  })

  it('retries metadata failures before marking terminal failure', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'retry-item',
        type: 'link',
        title: 'https://example.com/retry',
        content: null,
        sourceUrl: 'https://example.com/retry',
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()

    mockFetchUrlMetadata.mockRejectedValueOnce(new Error('temporary outage'))
    const retryId = queueInboxMetadataJob('retry-item', 'https://example.com/retry', {
      maxAttempts: 2,
      runAt: now
    })

    await vi.runOnlyPendingTimersAsync()
    await vi.dynamicImportSettled()

    const retryJob = testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, retryId)).get()
    expect(retryJob).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'temporary outage'
    })

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'terminal-item',
        type: 'link',
        title: 'https://example.com/terminal',
        content: null,
        sourceUrl: 'https://example.com/terminal',
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()

    mockFetchUrlMetadata.mockRejectedValueOnce(new Error('blocked'))
    const failedId = queueInboxMetadataJob('terminal-item', 'https://example.com/terminal', {
      maxAttempts: 1,
      runAt: now
    })

    await vi.runOnlyPendingTimersAsync()
    await vi.dynamicImportSettled()

    const item = testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'terminal-item')).get()
    const failedJob = testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, failedId)).get()

    expect(item).toMatchObject({
      title: 'https://example.com/terminal',
      processingStatus: 'failed',
      processingError: 'blocked',
      metadata: {
        url: 'https://example.com/terminal',
        fetchStatus: 'failed',
        error: 'blocked'
      }
    })
    expect(failedJob).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'blocked'
    })
  })

  it('processes transcription jobs and fails missing attachment paths', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'voice-ok',
        type: 'voice',
        title: 'Voice memo',
        content: null,
        attachmentPath: 'attachments/inbox/voice-ok/memo.webm',
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()
    testDb.db
      .insert(inboxItems)
      .values({
        id: 'voice-missing',
        type: 'voice',
        title: 'Missing memo',
        content: null,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()

    mockTranscribeAudio.mockResolvedValueOnce({
      success: true,
      transcription: 'remember the launch checklist'
    })

    const okId = queueInboxTranscriptionJob('voice-ok', 'attachments/inbox/voice-ok/memo.webm', {
      runAt: now
    })
    const missingId = queueInboxTranscriptionJob('voice-missing', '', { runAt: now })

    await vi.runOnlyPendingTimersAsync()

    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      'voice-ok',
      'attachments/inbox/voice-ok/memo.webm'
    )

    expect(testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, okId)).get()).toMatchObject({
      status: 'complete',
      result: { transcriptionLength: 29 }
    })
    expect(
      testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, missingId)).get()
    ).toMatchObject({
      status: 'failed',
      lastError: 'Voice item not found or missing attachment path.'
    })
  })

  it('marks unknown resumed job types as failed and ignores repeated resume calls', async () => {
    const now = new Date().toISOString()

    testDb.db
      .insert(inboxItems)
      .values({
        id: 'unknown-item',
        type: 'note',
        title: 'Unknown',
        content: null,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending'
      })
      .run()

    testDb.db
      .insert(inboxJobs)
      .values({
        id: 'unknown-job',
        itemId: 'unknown-item',
        type: 'unsupported-type',
        status: 'pending',
        runAt: now,
        attempts: 0,
        maxAttempts: 1,
        payload: null,
        createdAt: now,
        updatedAt: now
      })
      .run()

    resumeInboxJobs()
    resumeInboxJobs()
    await vi.runOnlyPendingTimersAsync()

    expect(
      testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, 'unknown-job')).get()
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'No processor registered for job type "unsupported-type".'
    })
  })
})
