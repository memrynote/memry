import { describe, it, expect } from 'vitest'
import { mapToArticleCapture } from './map.ts'

const NOW = '2026-06-17T00:00:00.000Z'

describe('mapToArticleCapture', () => {
  it('maps defuddle fields to the property set', () => {
    const capture = mapToArticleCapture(
      {
        content: 'Body text '.repeat(60),
        title: 'Running local models is good now',
        author: 'Vicki Boykis',
        published: '2026-06-15',
        description: 'Local agentic coding has gotten good.',
        image: 'https://example.com/hero.png',
        wordCount: 120
      },
      'https://example.com/article',
      { now: NOW }
    )

    expect(capture.url).toBe('https://example.com/article')
    expect(capture.mode).toBe('article')
    expect(capture.extractionStatus).toBe('full')
    expect(capture.heroImage).toBe('https://example.com/hero.png')
    expect(capture.properties).toEqual({
      title: 'Running local models is good now',
      source: 'https://example.com/article',
      author: ['Vicki Boykis'],
      published: '2026-06-15',
      created: NOW,
      description: 'Local agentic coding has gotten good.',
      tags: ['clippings']
    })
  })

  it('flags thin content as partial and empty content as failed', () => {
    const partial = mapToArticleCapture(
      { content: 'tiny', title: 'T', wordCount: 5 },
      'https://e.com/p',
      { now: NOW }
    )
    expect(partial.extractionStatus).toBe('partial')

    const failed = mapToArticleCapture({ content: '', title: 'T' }, 'https://e.com/f', {
      now: NOW
    })
    expect(failed.extractionStatus).toBe('failed')
  })

  it('omits optional properties when defuddle returns nothing', () => {
    const capture = mapToArticleCapture(
      { content: 'words '.repeat(200), title: 'Only title', wordCount: 200 },
      'https://e.com/x',
      { now: NOW }
    )
    expect(capture.properties.author).toBeUndefined()
    expect(capture.properties.published).toBeUndefined()
    expect(capture.properties.description).toBeUndefined()
  })
})
