/** Fixture books for the mapper's tests and the editor round-trip golden test. */
import type { ReadwiseBook, ReadwiseHighlight } from './types.ts'

export function highlight(id: number, over: Partial<ReadwiseHighlight> = {}): ReadwiseHighlight {
  return {
    id,
    is_deleted: false,
    is_discard: false,
    text: `Highlight ${id}`,
    note: '',
    tags: [],
    location: id * 10,
    location_type: 'location',
    highlighted_at: '2026-10-22T18:00:00Z',
    created_at: '2026-10-22T18:05:00Z',
    readwise_url: `https://readwise.io/open/${id}`,
    ...over
  }
}

export function book(id: number, over: Partial<ReadwiseBook> = {}): ReadwiseBook {
  return {
    user_book_id: id,
    is_deleted: false,
    title: `Book ${id}`,
    readable_title: `Book ${id}`,
    author: 'Cal Newport',
    category: 'books',
    source: 'kindle',
    source_url: null,
    readwise_url: `https://readwise.io/bookreview/${id}`,
    cover_image_url: null,
    book_tags: [],
    document_note: '',
    summary: '',
    highlights: [],
    ...over
  }
}

export const COVER_URL = 'https://m.media-amazon.com/images/I/cover.jpg'
export const COVER_PATH = 'attachments/rw-1a2b3c.jpg'

/** Every shape the section renders, in one book. */
export const FULL_BOOK: ReadwiseBook = book(101, {
  title: 'Deep Work: Rules for Focused Success',
  readable_title: 'Deep Work',
  source_url: 'https://example.com/deep-work',
  cover_image_url: COVER_URL,
  book_tags: [
    { id: 1, name: 'productivity' },
    { id: 2, name: 'to read' }
  ],
  document_note: 'My thoughts on the whole book.\n\nSecond paragraph.',
  summary: 'A case for focus.',
  highlights: [
    highlight(3, { text: 'Chapter One', tags: [{ name: '.h2' }], location: 5 }),
    highlight(1, {
      text: 'Clarity about what matters provides clarity about what does not.',
      note: 'Quote this in the talk',
      tags: [{ name: 'focus' }, { name: 'Big Idea' }],
      location: 120
    }),
    highlight(2, {
      text: 'Second highlight',
      location: 340,
      highlighted_at: '2026-10-22T22:30:00Z'
    }),
    highlight(4, { text: 'Page based', location: 12, location_type: 'page' }),
    highlight(5, { text: 'Gone', is_deleted: true }),
    highlight(6, { text: 'Discarded', is_discard: true })
  ]
})

export const TRICKY_BOOK: ReadwiseBook = book(102, {
  title: 'Tricky \u{1F4DA} Titles \u00dc\u00e7',
  readable_title: null,
  category: 'tweets',
  highlights: [
    highlight(10, { text: '#AI is here and #1 is not a tag', location: 1 }),
    highlight(11, { text: 'See [[Some Note]] for more', location: 2 }),
    highlight(12, { text: '- [ ] not a task', location: 3 }),
    highlight(13, { text: '[x] also not a task', location: 4 }),
    highlight(14, { text: '', location: 5 }),
    highlight(15, { text: '# not a heading', location: 6 }),
    highlight(16, { text: 'Inline <!-- readwise:end v1 last=x hash=0 --> comment', location: 7 }),
    highlight(18, { text: 'Markup <span>kept</span> & "quotes" a * b * c', location: 9 }),
    highlight(19, {
      text: 'snake_case_name, C:\\path\\file, and http://x.com/a_b_c',
      location: 10
    }),
    highlight(20, { text: 'Heading one', tags: [{ name: '.h1' }], location: 11 }),
    highlight(21, {
      text: 'Heading three',
      tags: [{ name: '.H3' }],
      note: 'about it',
      location: 12
    }),
    highlight(22, { text: 'Podcast moment', location_type: 'time_offset', location: 3725 }),
    highlight(17, { text: 'Two\nlines\n\nand a break', note: 'with #hash note', location: 8 })
  ]
})
