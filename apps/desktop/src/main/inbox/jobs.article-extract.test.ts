import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { BrowserWindow } from 'electron'
import { inboxItems, inboxJobs } from '@memry/db-schema/schema/inbox'
import {
  cleanupTestDatabase,
  createTestDataDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

const mockFetchUrlHtml = vi.hoisted(() => vi.fn())
const mockExtractFromHtml = vi.hoisted(() => vi.fn())

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
  fetchUrlHtml: mockFetchUrlHtml,
  fetchUrlMetadata: vi.fn(),
  downloadImage: vi.fn()
}))

vi.mock('@memry/article-extract/node', () => ({
  extractFromHtml: mockExtractFromHtml
}))

vi.mock('./metadata-utils', () => ({
  isBotPageTitle: vi.fn(() => false),
  titleFromUrl: vi.fn((url: string) => url)
}))

vi.mock('./attachments', () => ({
  getItemAttachmentsDir: vi.fn(() => '/tmp/inbox-item')
}))

vi.mock('./transcription', () => ({
  transcribeAudio: vi.fn()
}))

vi.mock('../projections', () => ({
  publishProjectionEvent: vi.fn()
}))

import { getDatabase, requireDatabase } from '../database'
import { processArticleExtractJob, teardownInboxJobScheduler } from './jobs'

describe('processArticleExtractJob', () => {
  let testDb: TestDatabaseResult
  let window: { webContents: { send: ReturnType<typeof vi.fn> } }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'))

    testDb = createTestDataDb()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    vi.mocked(requireDatabase).mockReturnValue(testDb.db)

    window = { webContents: { send: vi.fn() } }
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window] as never)

    mockFetchUrlHtml.mockReset().mockResolvedValue('<html><body>Article content</body></html>')
    mockExtractFromHtml.mockReset().mockResolvedValue({
      extractionStatus: 'full',
      contentMarkdown: '# Article\n\nArticle body text.',
      excerpt: 'Article body text.',
      properties: { author: 'Jane Doe', publishedDate: '2026-05-01' }
    })
  })

  afterEach(() => {
    teardownInboxJobScheduler()
    cleanupTestDatabase(testDb)
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function seedLinkItem(id: string, extraMetadata: Record<string, unknown> = {}) {
    const now = new Date().toISOString()
    testDb.db
      .insert(inboxItems)
      .values({
        id,
        type: 'link',
        title: 'https://example.com',
        content: null,
        sourceUrl: 'https://example.com',
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete',
        metadata: { url: 'https://example.com', ...extraMetadata }
      })
      .run()
    return id
  }

  function seedJob(jobId: string, itemId: string) {
    const now = new Date().toISOString()
    testDb.db
      .insert(inboxJobs)
      .values({
        id: jobId,
        itemId,
        type: 'article-extract',
        status: 'running',
        runAt: now,
        attempts: 1,
        maxAttempts: 2,
        payload: { url: 'https://example.com' },
        createdAt: now,
        updatedAt: now
      })
      .run()
  }

  function getJob(id: string) {
    return testDb.db.select().from(inboxJobs).where(eq(inboxJobs.id, id)).get()
  }

  function getItem(id: string) {
    return testDb.db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
  }

  it('happy path: sets content, merges existing metadata fields, marks job complete', async () => {
    seedLinkItem('item-ae', { siteName: 'Example', fetchStatus: 'complete' })
    seedJob('job-ae', 'item-ae')

    const db = testDb.db
    const job = db.select().from(inboxJobs).where(eq(inboxJobs.id, 'job-ae')).get()!

    await processArticleExtractJob(db as never, job as never)

    const item = getItem('item-ae')
    const metadata = item?.metadata as Record<string, unknown>

    // content set from extracted markdown
    expect(item?.content).toBe('# Article\n\nArticle body text.')

    // prior metadata-scrape fields preserved
    expect(metadata?.siteName).toBe('Example')
    expect(metadata?.fetchStatus).toBe('complete')

    // new extraction fields written
    expect(metadata?.extractionStatus).toBe('full')
    expect(metadata?.properties).toEqual({ author: 'Jane Doe', publishedDate: '2026-05-01' })

    // job marked complete
    expect(getJob('job-ae')?.status).toBe('complete')
  })

  it('failed extraction: marks job complete without overwriting existing content', async () => {
    seedLinkItem('item-ae-fail', { siteName: 'Example' })
    // pre-populate content that must survive
    testDb.db
      .update(inboxItems)
      .set({ content: 'Prior content from metadata-scrape' })
      .where(eq(inboxItems.id, 'item-ae-fail'))
      .run()
    seedJob('job-ae-fail', 'item-ae-fail')

    mockExtractFromHtml.mockResolvedValueOnce({
      extractionStatus: 'failed',
      contentMarkdown: null,
      excerpt: null,
      properties: null
    })

    const db = testDb.db
    const job = db.select().from(inboxJobs).where(eq(inboxJobs.id, 'job-ae-fail')).get()!

    await processArticleExtractJob(db as never, job as never)

    const item = getItem('item-ae-fail')

    // content must NOT be touched on failed extraction
    expect(item?.content).toBe('Prior content from metadata-scrape')

    // job still marks complete gracefully
    expect(getJob('job-ae-fail')?.status).toBe('complete')
  })
})
