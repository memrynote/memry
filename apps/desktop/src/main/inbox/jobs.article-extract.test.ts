import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('../database', () => ({
  requireDatabase: vi.fn(),
  getDatabase: vi.fn()
}))

vi.mock('./metadata', () => ({
  fetchUrlMetadata: vi.fn(),
  downloadImage: vi.fn(),
  fetchUrlHtml: vi.fn()
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

vi.mock('@memry/article-extract/node', () => ({
  extractFromHtml: vi.fn(async (_html: string, url: string) => ({
    url,
    mode: 'article' as const,
    contentMarkdown: '# Title\n\nBody.',
    excerpt: 'Body.',
    extractionStatus: 'full' as const,
    properties: {
      title: 'Title',
      source: url,
      created: '2026-06-17T00:00:00.000Z',
      tags: ['clippings']
    }
  }))
}))

describe('queueInboxArticleExtractJob', () => {
  it('is exported with the expected arity', async () => {
    const mod = await import('./jobs.ts')
    expect(typeof mod.queueInboxArticleExtractJob).toBe('function')
    expect(mod.queueInboxArticleExtractJob.length).toBe(2)
  })
})
