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
        created: '2026-06-17T00:00:00.000Z',
        tags: ['clippings']
      }
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
      properties: { title: 'x', source: 'https://example.com/p', created: 'x', tags: [] }
    })
    expect(r.success).toBe(false)
  })
})
