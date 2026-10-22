import { describe, expect, it } from 'vitest'
import { planReaderNote, type PlanReaderNoteOptions, type ReaderDocument } from './reader.ts'
import { readSection } from './section.ts'

const IMAGE_URL = 'https://cdn.example.com/cover.jpg'
const IMAGE_PATH = 'attachments/rw-abc123.jpg'

const OPTIONS: PlanReaderNoteOptions = {
  root: 'Readwise',
  folderLayout: 'by-category',
  images: new Map([[IMAGE_URL, IMAGE_PATH]])
}

const ARTICLE: ReaderDocument = {
  id: '01m5jnw4f13sws8chfdnaaj0pw',
  url: 'https://read.readwise.io/read/01m5jnw4f13sws8chfdnaaj0pw',
  title: 'Getting started with Reader',
  author: 'Readwise',
  source: 'readwise onboarding',
  category: 'article',
  location: 'new',
  tags: { Reading: { name: 'Reading' }, 'to read': { name: 'to read' } },
  site_name: 'Readwise Blog',
  word_count: 85,
  published_date: '2024-12-06',
  summary: 'Save things to read later.',
  image_url: IMAGE_URL,
  source_url: 'https://blog.readwise.io/p/96321ba4/',
  notes: 'Try the browser extension.\n\n\n- [ ] set it up',
  parent_id: null
}

const BARE: ReaderDocument = { id: 'doc-bare', location: 'later', category: 'pdf', parent_id: null }

function plan(document: ReaderDocument, over: Partial<PlanReaderNoteOptions> = {}) {
  const result = planReaderNote(document, { ...OPTIONS, ...over })
  if (!result) throw new Error('expected a note plan')
  return result
}

describe('planReaderNote', () => {
  it('renders an article with cover band, notes, and summary', () => {
    const result = plan(ARTICLE)
    expect(result.folder).toBe('Readwise/Reader')
    expect(result.title).toBe('Getting started with Reader')
    expect(result.frontmatter).toEqual({
      author: 'Readwise',
      category: 'article',
      source: 'readwise onboarding',
      source_url: 'https://blog.readwise.io/p/96321ba4/',
      readwise_url: 'https://read.readwise.io/read/01m5jnw4f13sws8chfdnaaj0pw',
      tags: ['Reading', 'to read'],
      site_name: 'Readwise Blog',
      published_date: '2024-12-06',
      word_count: 85,
      cover: IMAGE_PATH
    })
    expect(result.imageUrls).toEqual([IMAGE_URL])
    expect(result.section).toMatchInlineSnapshot(`
      "<!-- readwise:start -->

      ## Document note

      Try the browser extension.

      -​ [​ ] set it up

      ## Summary

      Save things to read later.

      ## Highlights

      <!-- readwise:end v1 last=1970-01-01T00:00:00.000Z hash=80cf2e3a -->"
    `)
    expect(readSection(result.section)).toMatchObject({ found: true, untouched: true })
  })

  it('renders a document with no content as an empty Highlights section', () => {
    const result = plan(BARE)
    expect(result.title).toBe('Untitled')
    expect(result.frontmatter).toEqual({
      category: 'pdf',
      readwise_url: 'https://read.readwise.io/read/doc-bare'
    })
    expect(result.imageUrls).toEqual([])
    expect(result.fullText).toBeNull()
    const read = readSection(result.section)
    expect(read).toMatchObject({ found: true, untouched: true, text: '\n## Highlights\n' })
  })

  it('puts a non-article image at the top of the section, not in the frontmatter', () => {
    const result = plan({ ...ARTICLE, category: 'pdf' })
    expect(result.frontmatter).not.toHaveProperty('cover')
    expect(result.section).toContain(
      `<!-- readwise:start -->\n\n![](${IMAGE_PATH})\n\n## Document note`
    )
  })

  it('leaves the image out when it is not saved', () => {
    const result = plan(ARTICLE, { images: new Map() })
    expect(result.frontmatter).not.toHaveProperty('cover')
    expect(result.section).not.toContain(IMAGE_URL)
    expect(result.imageUrls).toEqual([IMAGE_URL])
  })

  it('returns fullText apart from the section', () => {
    const result = plan(ARTICLE, { fullText: '\n# Body\n\nText.\n' })
    expect(result.fullText).toBe('# Body\n\nText.')
    expect(result.section).not.toContain('Text.')
  })

  it.each([
    ['a child document', { ...ARTICLE, parent_id: 'parent' }, undefined],
    ['a feed item', { ...ARTICLE, location: 'feed' }, undefined],
    ['a document with a v2 book', ARTICLE, new Set([ARTICLE.id])]
  ])('returns no plan for %s', (_name, document, bookExternalIds) => {
    expect(planReaderNote(document, { ...OPTIONS, bookExternalIds })).toBeNull()
  })

  it('uses the root for the flat layout', () => {
    expect(plan(ARTICLE, { folderLayout: 'flat', root: 'Readwise/' }).folder).toBe('Readwise')
  })

  it('reads a Unix published_date as a day', () => {
    expect(plan({ ...ARTICLE, published_date: 1733443200 }).frontmatter.published_date).toBe(
      '2024-12-06'
    )
  })

  it('renders identical input to identical bytes', () => {
    expect(plan(ARTICLE)).toEqual(plan({ ...ARTICLE }))
  })
})
