import { describe, it, expect } from 'vitest'
import { extractItemProperties, generateNoteContent, getFiledBinaryFilename } from './filing.ts'

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

describe('getFiledBinaryFilename', () => {
  function binary(
    overrides: Partial<Parameters<typeof getFiledBinaryFilename>[0]>
  ): Parameters<typeof getFiledBinaryFilename>[0] {
    return {
      type: 'pdf',
      title: 'Quarterly Report',
      attachmentPath: 'attachments/inbox/pdf-1/a1b2c3-scan_final_v3.pdf',
      ...overrides
    } as Parameters<typeof getFiledBinaryFilename>[0]
  }

  // #808: renaming an image/PDF in the inbox is what names the file in the vault.
  it('names a filed binary after the item title, keeping the extension', () => {
    expect(getFiledBinaryFilename(binary({}))).toBe('Quarterly Report.pdf')
    expect(getFiledBinaryFilename(binary({ type: 'image', title: 'Whiteboard' }))).toBe(
      'Whiteboard.pdf'
    )
  })

  it('still names filed voice memos after their title', () => {
    expect(
      getFiledBinaryFilename(
        binary({
          type: 'voice',
          title: 'Standup notes',
          attachmentPath: 'attachments/inbox/voice-1/voice-memo.m4a'
        })
      )
    ).toBe('Standup notes.m4a')
  })

  it('strips path separators and other filesystem-hostile characters', () => {
    expect(getFiledBinaryFilename(binary({ title: 'Q3/Q4: revenue*' }))).toBe('Q3Q4 revenue.pdf')
  })

  it('strips leading dots so a title cannot produce a hidden or traversal-shaped name', () => {
    expect(getFiledBinaryFilename(binary({ title: '..config' }))).toBe('config.pdf')
    expect(getFiledBinaryFilename(binary({ title: '.hidden' }))).toBe('hidden.pdf')
  })

  it('falls back to the capture-time filename when nothing survives sanitization', () => {
    expect(getFiledBinaryFilename(binary({ title: '...' }))).toBe('a1b2c3-scan_final_v3.pdf')
    expect(getFiledBinaryFilename(binary({ title: '///' }))).toBe('a1b2c3-scan_final_v3.pdf')
  })
})
