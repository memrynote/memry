import { describe, it, expect, vi, beforeEach } from 'vitest'

const updateRun = vi.fn()
const selectGet = vi.fn()
const insertSpy = vi.fn()
const findDuplicateByUrl = vi.fn()
let setArg: Record<string, unknown> = {}

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('./duplicates', () => ({ findDuplicateByUrl }))
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
    findDuplicateByUrl.mockReset()
    findDuplicateByUrl.mockReturnValue(null) // no active duplicate by default
    setArg = {}
  })

  it('creates a new link item with properties + extraction status when no itemId', async () => {
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
          created: '2026-06-17T00:00:00.000Z'
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
          created: '2026-06-17T00:00:00.000Z'
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

  it('creates a new item when the URL was already filed (no active duplicate)', async () => {
    findDuplicateByUrl.mockReturnValue(null) // filed/archived rows are excluded by the active filter
    // A bare sourceUrl query (the old dedup) WOULD find the filed row — guards against regressing to it.
    selectGet.mockReturnValue({ id: 'filed-1', metadata: {} })
    const { ingestArticleCapture } = await import('./ingest')
    const res = await ingestArticleCapture(
      {
        url: 'https://example.com/post',
        mode: 'article',
        contentMarkdown: '# Hello',
        excerpt: 'body',
        extractionStatus: 'full',
        properties: {
          title: 'Hello',
          source: 'https://example.com/post',
          created: '2026-06-17T00:00:00.000Z'
        }
      },
      'browser-extension'
    )
    expect(res.itemId).toBeTruthy()
    expect(insertSpy).toHaveBeenCalledOnce()
    expect(updateRun).not.toHaveBeenCalled()
  })

  it('enriches in place when an active duplicate URL exists', async () => {
    findDuplicateByUrl.mockReturnValue({
      id: 'active-1',
      title: 'Hello',
      createdAt: '2026-06-17T00:00:00.000Z'
    })
    selectGet.mockReturnValue({ id: 'active-1', metadata: { fetchStatus: 'complete' } })
    const { ingestArticleCapture } = await import('./ingest')
    const res = await ingestArticleCapture(
      {
        url: 'https://example.com/post',
        mode: 'article',
        contentMarkdown: '# Hello again',
        excerpt: 'body',
        extractionStatus: 'full',
        properties: {
          title: 'Hello',
          source: 'https://example.com/post',
          created: '2026-06-17T00:00:00.000Z'
        }
      },
      'browser-extension'
    )
    expect(res.itemId).toBe('active-1')
    expect(insertSpy).not.toHaveBeenCalled()
    expect(updateRun).toHaveBeenCalled()
  })
})
