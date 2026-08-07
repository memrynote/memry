import { describe, it, expect } from 'vitest'
import { ArticleCaptureSchema } from './capture-api'

describe('ArticleCaptureSchema', () => {
  it('accepts a minimal article capture', () => {
    const r = ArticleCaptureSchema.safeParse({
      url: 'https://example.com/p',
      mode: 'article',
      contentMarkdown: '# x',
      excerpt: 'x',
      extractionStatus: 'full',
      properties: {
        title: 'x',
        source: 'https://example.com/p',
        created: '2026-06-17T00:00:00.000Z'
      },
      tags: ['clippings']
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const r = ArticleCaptureSchema.safeParse({
      url: 'https://example.com/p',
      mode: 'video',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      properties: { title: 'x', source: 'https://example.com/p', created: 'x' }
    })
    expect(r.success).toBe(false)
  })

  it('accepts a screenshot payload with screenshotDataUrl + force', () => {
    const r = ArticleCaptureSchema.safeParse({
      url: 'https://example.com/p',
      mode: 'screenshot',
      contentMarkdown: '',
      excerpt: '',
      extractionStatus: 'full',
      properties: {
        title: 't',
        source: 'https://example.com/p',
        created: '2026-06-17T00:00:00.000Z'
      },
      screenshotDataUrl: 'data:image/png;base64,AAAA',
      force: true
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.screenshotDataUrl).toBe('data:image/png;base64,AAAA')
  })
})

describe('ArticleCaptureSchema — pdf mode', () => {
  const base = {
    url: 'https://example.com/paper.pdf',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full' as const,
    properties: {
      title: 'paper',
      source: 'https://example.com/paper.pdf',
      created: '2026-08-08T00:00:00.000Z'
    }
  }

  it('accepts a pdf capture carrying bytes and a filename', () => {
    const parsed = ArticleCaptureSchema.safeParse({
      ...base,
      mode: 'pdf',
      force: true,
      pdfDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK',
      pdfFilename: 'paper.pdf'
    })
    expect(parsed.success).toBe(true)
  })

  it('still accepts an article capture with none of the pdf fields (old extensions)', () => {
    const parsed = ArticleCaptureSchema.safeParse({
      ...base,
      mode: 'article',
      contentMarkdown: '# Hello'
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const parsed = ArticleCaptureSchema.safeParse({ ...base, mode: 'epub' })
    expect(parsed.success).toBe(false)
  })
})
