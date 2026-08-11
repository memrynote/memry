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
const storeInboxAttachment = vi.fn()
vi.mock('./attachments', () => ({
  getItemAttachmentsDir: vi.fn(() => '/tmp/inbox-item'),
  storeInboxAttachment: (...args: unknown[]) => storeInboxAttachment(...args)
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
    storeInboxAttachment.mockReset()
    storeInboxAttachment.mockResolvedValue({
      success: true,
      path: 'attachments/inbox/x/ab12-paper.pdf'
    })
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

  const pdfInput = {
    url: 'https://example.com/paper.pdf',
    mode: 'pdf' as const,
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full' as const,
    force: true,
    pdfDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
    pdfFilename: 'paper.pdf',
    properties: {
      title: 'paper',
      source: 'https://example.com/paper.pdf',
      created: '2026-08-08T00:00:00.000Z'
    }
  }

  it('stores the pdf bytes and creates a pdf item', async () => {
    const { ingestArticleCapture } = await import('./ingest')
    await ingestArticleCapture(pdfInput, 'browser-extension')

    expect(storeInboxAttachment).toHaveBeenCalledOnce()
    const [, buffer, filename, mime] = storeInboxAttachment.mock.calls[0]
    expect(filename).toBe('paper.pdf')
    expect(mime).toBe('application/pdf')
    expect((buffer as Buffer).subarray(0, 5).toString()).toBe('%PDF-')

    const [row] = insertSpy.mock.calls[0]
    expect(row.type).toBe('pdf')
    expect(row.content).toBeNull()
    expect(row.attachmentPath).toBe('attachments/inbox/x/ab12-paper.pdf')
    expect(row.sourceUrl).toBe('https://example.com/paper.pdf')
    expect(row.metadata.originalFilename).toBe('paper.pdf')
    expect(row.metadata.mimeType).toBe('application/pdf')
    expect(row.metadata.fileSize).toBeGreaterThan(0)
  })

  it('falls back to a link item when the data URL is not a pdf', async () => {
    const { ingestArticleCapture } = await import('./ingest')
    await ingestArticleCapture(
      { ...pdfInput, pdfDataUrl: 'data:text/html;base64,PGh0bWw+' },
      'browser-extension'
    )

    expect(storeInboxAttachment).not.toHaveBeenCalled()
    const [row] = insertSpy.mock.calls[0]
    expect(row.type).toBe('link')
    expect(row.attachmentPath).toBeNull()
  })

  it('falls back to a link item when storing the attachment fails', async () => {
    storeInboxAttachment.mockResolvedValue({ success: false, error: 'File too large' })
    const { ingestArticleCapture } = await import('./ingest')
    await ingestArticleCapture(pdfInput, 'browser-extension')

    const [row] = insertSpy.mock.calls[0]
    expect(row.type).toBe('link')
    expect(row.attachmentPath).toBeNull()
  })

  it('defaults the filename when the extension sent none', async () => {
    const { ingestArticleCapture } = await import('./ingest')
    const { pdfFilename: _omitted, ...noFilename } = pdfInput
    await ingestArticleCapture(noFilename, 'browser-extension')

    expect(storeInboxAttachment.mock.calls[0][2]).toBe('document.pdf')
  })
})
