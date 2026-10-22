import { describe, expect, it } from 'vitest'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { isInlineTagName } from '@memry/shared/inline-tags'
import { COVER_PATH, COVER_URL, FULL_BOOK, TRICKY_BOOK, book, highlight } from './fixtures.ts'
import { planNote, type NotePlan, type PlanNoteOptions } from './plan-note.ts'
import { hashSectionBody, readSection } from './section.ts'

const OPTIONS: PlanNoteOptions = {
  root: 'Readwise',
  folderLayout: 'by-category',
  categories: {},
  timeZone: 'UTC',
  images: new Map([[COVER_URL, COVER_PATH]])
}

function plan(
  source: Parameters<typeof planNote>[0],
  over: Partial<PlanNoteOptions> = {}
): NotePlan {
  const result = planNote(source, { ...OPTIONS, ...over })
  if (!result || 'deleted' in result) throw new Error('expected a note plan')
  return result
}

describe('planNote', () => {
  it('renders a full book to the exact section bytes', () => {
    const result = plan(FULL_BOOK)
    expect(result.folder).toBe('Readwise/Books')
    expect(result.title).toBe('Deep Work')
    expect(result.frontmatter).toEqual({
      author: 'Cal Newport',
      category: 'books',
      source: 'kindle',
      source_url: 'https://example.com/deep-work',
      readwise_url: 'https://readwise.io/bookreview/101',
      tags: ['productivity', 'to read']
    })
    expect(result.imageUrls).toEqual([COVER_URL])
    expect(result.last).toBe('2026-10-22T18:05:00.000Z')
    expect(result.section).toBe(
      [
        '<!-- readwise:start -->',
        '',
        '![](attachments/rw-1a2b3c.jpg)',
        '',
        '## Document note',
        '',
        'My thoughts on the whole book.',
        '',
        'Second paragraph.',
        '',
        '## Summary',
        '',
        'A case for focus.',
        '',
        '## Highlights',
        '',
        '#### Chapter One',
        '',
        '- Page based ([Page 12](https://readwise.io/open/4), 2026-10-22)',
        '- Clarity about what matters provides clarity about what does not. ([Location 120](https://readwise.io/open/1), 2026-10-22) #focus #Big-Idea',
        '  - Quote this in the talk',
        '- Second highlight ([Location 340](https://readwise.io/open/2), 2026-10-22)',
        '',
        `<!-- readwise:end v1 last=2026-10-22T18:05:00.000Z hash=${hashSectionBody(
          result.section.split('\n').slice(2, -2).join('\n')
        )} -->`
      ].join('\n')
    )
  })

  it('renders identical bytes for identical input, whatever the highlight order', () => {
    const reversed = { ...FULL_BOOK, highlights: [...(FULL_BOOK.highlights ?? [])].reverse() }
    expect(plan(reversed).section).toBe(plan(FULL_BOOK).section)
  })

  it('writes a section whose end marker matches its own body', () => {
    const body = `x\n${plan(FULL_BOOK).section}`
    const read = readSection(body)
    expect(read.found && read.untouched).toBe(true)
  })

  it('shows the date in the given time zone', () => {
    const late = book(1, { highlights: [highlight(1, { highlighted_at: '2026-10-22T22:30:00Z' })] })
    expect(plan(late, { timeZone: 'UTC' }).section).toContain(', 2026-10-22)')
    expect(plan(late, { timeZone: 'Europe/Istanbul' }).section).toContain(', 2026-10-23)')
  })

  it('uses created_at when highlighted_at is missing', () => {
    const undated = book(1, {
      highlights: [highlight(1, { highlighted_at: null, created_at: '2026-01-02T03:04:05Z' })]
    })
    expect(plan(undated).section).toContain(', 2026-01-02)')
  })

  it('leaves out deleted and discarded highlights', () => {
    const section = plan(FULL_BOOK).section
    expect(section).not.toContain('Gone')
    expect(section).not.toContain('Discarded')
  })

  it('puts an article cover in the frontmatter and no image line in the section', () => {
    const article = plan(
      book(2, { category: 'articles', cover_image_url: COVER_URL, highlights: [highlight(1)] })
    )
    expect(article.frontmatter.cover).toBe(COVER_PATH)
    expect(article.section).not.toContain('![](')
    expect(article.folder).toBe('Readwise/Articles')
  })

  it('puts a book cover in the section and no cover in the frontmatter', () => {
    const result = plan(book(3, { cover_image_url: COVER_URL }))
    expect(result.frontmatter).not.toHaveProperty('cover')
    expect(result.section).toContain(`![](${COVER_PATH})`)
  })

  it('never lets a remote image URL reach the note when the image is not saved', () => {
    const remote = 'https://cdn.example.com/a.png'
    const source = book(4, {
      category: 'articles',
      cover_image_url: COVER_URL,
      highlights: [highlight(1, { text: `![](${remote})` }), highlight(2)]
    })
    const result = plan(source, { images: new Map() })
    expect(result.imageUrls).toEqual([COVER_URL, remote])
    expect(result.frontmatter).not.toHaveProperty('cover')
    expect(result.section).not.toContain('http://cdn')
    expect(result.section).not.toContain(remote)
    expect(result.section).not.toContain(COVER_URL)
    expect(result.section).toContain('Highlight 2')
  })

  it('holds `last` back to an image that is still missing', () => {
    const source = book(5, {
      highlights: [
        highlight(1, {
          text: '![](https://cdn.example.com/a.png)',
          created_at: '2026-10-01T00:00:00Z'
        }),
        highlight(2, { created_at: '2026-10-05T00:00:00Z' })
      ]
    })
    expect(plan(source, { images: new Map() }).last).toBe('1970-01-01T00:00:00.000Z')
  })

  it('renders a saved image highlight as an attachment image', () => {
    const remote = 'https://cdn.example.com/a.png'
    const source = book(6, { highlights: [highlight(1, { text: `![](${remote})` })] })
    const result = plan(source, { images: new Map([[remote, 'attachments/my image.png']]) })
    expect(result.section).toContain('- ![](<attachments/my image.png>) ([Location 10]')
  })

  it('renders heading highlights at their location and keeps their tags off the inline list', () => {
    const section = plan(FULL_BOOK).section
    expect(section).toContain('#### Chapter One')
    expect(section).not.toContain('#.h2')
  })

  it('omits document note and summary when the book has none', () => {
    const section = plan(book(7, { highlights: [highlight(1)] })).section
    expect(section).not.toContain('## Document note')
    expect(section).not.toContain('## Summary')
    expect(section).toContain('## Highlights')
  })

  it('renders an empty book as an empty Highlights section', () => {
    const result = plan(book(8))
    expect(result.last).toBe('1970-01-01T00:00:00.000Z')
    expect(result.section).toContain('## Highlights')
  })

  it('keeps Readwise text from becoming Memry syntax', () => {
    const { section } = plan(TRICKY_BOOK)
    const inlineTags = extractInlineTagsFromMarkdown(section)
    expect(inlineTags).toEqual([])
    expect(section).not.toMatch(/\[\[/)
    expect(section).not.toContain('<span>')
    expect(section).not.toMatch(/- \[[ xX]\]/)
    expect(section).not.toMatch(/\n- #\s/)
    expect(section.match(/<!-- readwise:end/g)).toHaveLength(1)
    expect(section).toContain('#\u200bAI')
  })

  it('keeps unicode and emoji titles whole', () => {
    expect(plan(TRICKY_BOOK).title).toBe('Tricky \u{1F4DA} Titles \u00dc\u00e7')
  })

  it('renders empty text as the link alone', () => {
    const empty = book(9, { highlights: [highlight(1, { text: '' })] })
    expect(plan(empty).section).toContain(
      '\n- ([Location 10](https://readwise.io/open/1), 2026-10-22)\n'
    )
  })

  it('normalizes highlight tags to the inline tag grammar', () => {
    const tagged = book(10, {
      highlights: [
        highlight(1, {
          tags: [
            { name: 'Big Idea' },
            { name: '2024 goals' },
            { name: 'caf\u00e9/au lait' },
            { name: '#already' },
            { name: 'BIG IDEA' },
            { name: '???' }
          ]
        })
      ]
    })
    const line = plan(tagged)
      .section.split('\n')
      .find((l) => l.startsWith('- '))!
    const tags = line.match(/ #(\S+)/g)!.map((t) => t.trim().slice(1))
    expect(tags).toEqual(['Big-Idea', 'goals', 'cafe/au-lait', 'already'])
    for (const tag of tags) expect(isInlineTagName(tag)).toBe(true)
  })

  describe('categories and layout', () => {
    const supplementals = book(11, { category: 'supplementals', highlights: [highlight(1)] })

    it('skips a switched-off category and syncs it once switched on', () => {
      expect(planNote(supplementals, OPTIONS)).toBeNull()
      expect(
        planNote(supplementals, { ...OPTIONS, categories: { supplementals: false } })
      ).toBeNull()
      expect(plan(supplementals, { categories: { supplementals: true } }).folder).toBe(
        'Readwise/Supplementals'
      )
      expect(planNote(book(12), { ...OPTIONS, categories: { books: false } })).toBeNull()
    })

    it('maps every category and an unknown one to its English folder', () => {
      const folder = (category: string): string => plan(book(13, { category })).folder
      expect(folder('books')).toBe('Readwise/Books')
      expect(folder('tweets')).toBe('Readwise/Tweets')
      expect(folder('podcasts')).toBe('Readwise/Podcasts')
      expect(folder('something-new')).toBe('Readwise/Other')
    })

    it('puts every note in the root with the flat layout, whatever the root is', () => {
      expect(plan(book(14, { category: 'tweets' }), { folderLayout: 'flat' }).folder).toBe(
        'Readwise'
      )
      expect(plan(book(14), { folderLayout: 'flat', root: 'Reading/Notes/' }).folder).toBe(
        'Reading/Notes'
      )
      expect(plan(book(14), { root: 'My Library' }).folder).toBe('My Library/Books')
    })
  })

  it('marks a deleted book for the caller instead of planning a note', () => {
    expect(planNote(book(15, { is_deleted: true }), OPTIONS)).toEqual({
      deleted: true,
      readwiseUrl: 'https://readwise.io/bookreview/15'
    })
  })
})
