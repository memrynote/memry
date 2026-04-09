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
  downloadImage: mockDownloadImage,
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
import { resumeInboxJobs, teardownInboxJobScheduler } from './jobs'

describe('inbox jobs', () => {
  let testDb: TestDatabaseResult
  let window: { webContents: { send: ReturnType<typeof vi.fn> } }

  beforeEach(() => {
    vi.useFakeTimers()

    testDb = createTestDataDb()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    vi.mocked(requireDatabase).mockReturnValue(testDb.db)

    window = { webContents: { send: vi.fn() } }
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

    const item = testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'item-1')).get()
    const job = testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, 'job-1')).get()

    expect(item?.processingStatus).toBe('complete')
    expect(item?.title).toBe('Resolved title')
    expect(job?.status).toBe('complete')
    expect(window.webContents.send).toHaveBeenCalled()
  })
})
