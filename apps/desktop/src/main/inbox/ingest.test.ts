import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateRun = vi.fn()
const selectGet = vi.fn()
const insertSpy = vi.fn()
let setArg: Record<string, unknown> = {}

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('../projections', () => ({
  publishProjectionEvent: vi.fn()
}))
vi.mock('./attachments', () => ({
  getItemAttachmentsDir: vi.fn(() => '/tmp/inbox-item')
}))
vi.mock('./domain', () => ({
  insertItemWithTags: (_db: unknown, row: { id: string }, tags: string[]) => {
    insertSpy(row, tags)
    return { row: { ...row }, tags }
  },
  emitCapturedAndSync: (row: { id: string }) => ({ id: row.id })
}))
vi.mock('./metadata', () => ({ downloadImage: vi.fn(async () => 'hero.webp') }))
vi.mock('../database', () => ({
  requireDatabase: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: selectGet }) }) }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        setArg = payload
        return { where: () => ({ run: updateRun }) }
      }
    })
  })
}))

describe('ingestArticleCapture', () => {
  beforeEach(() => {
    updateRun.mockReset()
    insertSpy.mockReset()
    selectGet.mockReset()
    setArg = {}
  })

  it('creates a new link item with properties + extraction status when no itemId', async () => {
    selectGet.mockReturnValue(undefined) // no dedup hit
    const { ingestArticleCapture } = await import('./ingest')
    const res = await ingestArticleCapture(
      {
        url: 'https://example.com/post',
        mode: 'article',
        contentMarkdown: '# Hello\n\nbody',
        excerpt: 'body',
        extractionStatus: 'full',
        properties: {
          title: 'Hello',
          source: 'https://example.com/post',
          created: '2026-06-17T00:00:00.000Z',
          tags: ['clippings']
        }
      },
      'browser-extension'
    )
    expect(res.itemId).toBeTruthy()
    expect(insertSpy).toHaveBeenCalledOnce()
    const [row] = insertSpy.mock.calls[0]
    expect(row.type).toBe('link')
    expect(row.captureSource).toBe('browser-extension')
    expect(row.metadata.extractionStatus).toBe('full')
    expect(row.metadata.properties.title).toBe('Hello')
  })

  it('enriches the existing item in place when itemId is given', async () => {
    selectGet.mockReturnValue({
      id: 'item-1',
      sourceUrl: 'https://example.com/post',
      metadata: { siteName: 'Example', fetchStatus: 'complete' }
    })
    const { ingestArticleCapture } = await import('./ingest')
    const res = await ingestArticleCapture(
      {
        itemId: 'item-1',
        url: 'https://example.com/post',
        mode: 'article',
        contentMarkdown: '# Hello',
        excerpt: 'x',
        extractionStatus: 'partial',
        properties: {
          title: 'Hello',
          source: 'https://example.com/post',
          created: '2026-06-17T00:00:00.000Z',
          tags: ['clippings']
        }
      },
      'api'
    )
    expect(res.itemId).toBe('item-1')
    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateRun).toHaveBeenCalled()
    // pre-existing metadata must be preserved
    expect((setArg.metadata as Record<string, unknown>).siteName).toBe('Example')
    // new fields written by enrich path
    expect((setArg.metadata as Record<string, unknown>).extractionStatus).toBe('partial')
    expect(
      ((setArg.metadata as Record<string, unknown>).properties as Record<string, unknown>).title
    ).toBe('Hello')
    expect(setArg.content).toBe('# Hello')
  })
})
