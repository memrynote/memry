import { describe, it, expect } from 'vitest'
import { extractItemProperties, generateNoteContent } from './filing.ts'

describe('extractItemProperties', () => {
  it('returns the properties object from item metadata', () => {
    const props = extractItemProperties({
      url: 'https://e.com',
      properties: { title: 'T', source: 'https://e.com', tags: ['clippings'] }
    })
    expect(props).toEqual({ title: 'T', source: 'https://e.com', tags: ['clippings'] })
  })

  it('returns undefined when there are no properties', () => {
    expect(extractItemProperties({ url: 'https://e.com' })).toBeUndefined()
    expect(extractItemProperties(null)).toBeUndefined()
    expect(extractItemProperties('not-an-object')).toBeUndefined()
  })
})

describe('generateNoteContent link body', () => {
  it('renders an extracted article as the note body (no blockquote, no meta lines)', () => {
    const item = {
      type: 'link',
      sourceUrl: 'https://example.com/article',
      title: 'Running local models is good now',
      content: '# Running local models is good now\n\nThe body of the article.',
      metadata: {
        url: 'https://example.com/article',
        author: 'Vicki Boykis',
        extractionStatus: 'full',
        properties: { title: 'Running local models is good now' }
      },
      thumbnailPath: null
    } as Parameters<typeof generateNoteContent>[0]

    const content = generateNoteContent(item)
    expect(content).toContain('"mention")')
    expect(content).toContain('The body of the article.')
    expect(content).not.toContain('> # Running local models')
    expect(content).not.toContain('**Author:**')
    expect(content).toContain('Filed from Inbox')
  })

  it('keeps the blockquote description + meta lines for a non-extracted link', () => {
    const item = {
      type: 'link',
      sourceUrl: 'https://example.com/x',
      title: 'Some link',
      content: 'A short captured description.',
      metadata: { url: 'https://example.com/x', author: 'Jane Doe' },
      thumbnailPath: null
    } as Parameters<typeof generateNoteContent>[0]

    const content = generateNoteContent(item)
    expect(content).toContain('> A short captured description.')
    expect(content).toContain('**Author:** Jane Doe')
  })
})
