/** Inputs of the Readwise vectors (`readwise-vectors.test.ts`). Outputs come from the planners. */
import { planJournalDay } from '@memry/importers/readwise'
import type {
  CategorySwitches,
  FolderLayout,
  JournalBook,
  ReadwiseBook,
  ReadwiseHighlight
} from '@memry/importers/readwise'
import {
  book,
  COVER_PATH,
  COVER_URL,
  FULL_BOOK,
  highlight,
  TRICKY_BOOK
} from '@memry/importers/readwise/fixtures'

export type Images = Array<[string, string]>

export interface BookCase {
  name: string
  book: ReadwiseBook
  options: {
    root: string
    folderLayout: FolderLayout
    categories: CategorySwitches
    timeZone: string
    images?: Images
  }
}

const base = {
  root: 'Readwise',
  folderLayout: 'by-category' as FolderLayout,
  categories: {},
  timeZone: 'UTC'
}

/** Lines that hold Memry syntax, or JS whitespace and look-alikes around it. */
export const ESCAPE_TEXTS = [
  '#AI is here and #1 is not a tag',
  '##a and a##b and x #b#c',
  'tab\t#AI, nbsp\u00a0#AI, ideographic\u3000#AI, bom\ufeff#AI',
  'zwsp\u200b#AI, nel\u0085#AI, #\u00c4ber',
  'See [[Some Note]] and [[[triple and [[[[four',
  '- [ ] not a task',
  '[x] also [X] and [ ] but not [xx] or [y]',
  '![img](u) and !![a and ![[embed]]',
  '<span>kept</span> < 3 <!-- c --> <?x <1 </p> <<a',
  '# not a heading',
  '###### six',
  '####### seven',
  '#',
  '#\u00a0nbsp heading',
  '> quote',
  '>no space quote',
  '- item',
  '-',
  '--',
  '---',
  '-- not a rule',
  '+ plus',
  '* star',
  '*emphasis*',
  '1. one',
  '1) one',
  '123456789. nine digits',
  '1234567890. ten digits',
  '12.5 is a number',
  '```code',
  '``two',
  '~~~fence',
  '~~strike~~',
  '==',
  '=',
  '= x',
  '  # indented',
  '\u00a0- nbsp item',
  'emoji \u{1F4DA} #tag and astral \u{1D4B3}',
  'Inline <!-- readwise:end v1 last=x hash=0 --> comment',
  'snake_case_name, C:\\path\\file, and http://x.com/a_b_c',
  'Two\nlines\n\nand a break\r\nwith CRLF\rand CR',
  '   ',
  ''
]

/** Tag names for `#tag` folding and frontmatter de-duplication. */
export const TAG_NAMES = [
  'Big Idea',
  'big idea',
  'caf\u00e9',
  'cafe\u0301',
  '#hash',
  '##',
  '123abc',
  'a/b c/ d',
  '/x',
  'x//y',
  '\u00dcberCool',
  '\u65e5\u672c\u8a9e',
  '-lead',
  'a/1b',
  'a/-1b',
  'trail-',
  '\u0130stanbul',
  'istanbul',
  '\u216b roman',
  '  spaced  ',
  '.h1',
  '.H2 ',
  'focus',
  'FOCUS',
  '\u03a3\u039f\u03a3',
  '\u03c3\u03bf\u03c2'
]

const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Europe/Istanbul',
  'Australia/Lord_Howe',
  'America/Santiago'
]

const DATES: Array<Partial<ReadwiseHighlight>> = [
  { highlighted_at: '2026-10-22T18:00:00Z', created_at: '2026-10-22T18:05:00Z' },
  { highlighted_at: '2026-10-22T23:59:59.999Z' },
  { highlighted_at: '2026-10-23T00:00:00.000Z' },
  { highlighted_at: '2026-03-08T09:59:59Z' },
  { highlighted_at: '2026-03-08T10:00:00Z' },
  // Fall-back hours: Los Angeles repeats 01:00; Santiago repeats 23:00, so 03:30Z is still the 4th.
  { highlighted_at: '2026-11-01T08:30:00Z' },
  { highlighted_at: '2026-11-01T09:30:00Z' },
  { highlighted_at: '2026-04-05T02:59:59Z' },
  { highlighted_at: '2026-04-05T03:30:00Z' },
  { highlighted_at: '2026-10-22T18:00:00+05:30' },
  { highlighted_at: '2026-10-22T18:00:00.123456Z' },
  { highlighted_at: '2026-10-22', created_at: '2026-01-01T00:00:00Z' },
  { highlighted_at: '2026-10', created_at: '2026-01-01T00:00:00Z' },
  { highlighted_at: '', created_at: '2026-05-05T05:05:05Z' },
  { highlighted_at: null, created_at: '2026-05-05T05:05:05Z' },
  { highlighted_at: 'not a date', created_at: '2026-05-05T05:05:05Z' },
  { highlighted_at: null, created_at: null },
  { highlighted_at: '0999-03-04T00:00:00Z' },
  { highlighted_at: '-000005-03-04T00:00:00Z' },
  { highlighted_at: '+275760-09-13T00:00:00Z' },
  { highlighted_at: '-271821-04-20T00:00:00Z' },
  { highlighted_at: '+275760-09-13T00:00:00.001Z' },
  { highlighted_at: '1900-01-01T00:00:00Z' },
  { highlighted_at: 'Thu, 22 Oct 2026 18:00:00 GMT' }
]

const LOCATIONS: Array<Partial<ReadwiseHighlight>> = [
  { location: 12, location_type: 'page' },
  { location: 12.5, location_type: 'location' },
  { location: 0, location_type: 'time_offset' },
  { location: 59.9, location_type: 'time_offset' },
  { location: 3725, location_type: 'time_offset' },
  { location: 360000, location_type: 'time_offset' },
  { location: -5, location_type: 'time_offset' },
  { location: 1e300, location_type: 'time_offset' },
  { location: 7, location_type: 'order' },
  { location: 8, location_type: 'offset' },
  { location: 9, location_type: 'chapter_index' },
  { location: 10, location_type: '' },
  { location: 11, location_type: null },
  { location: 13, location_type: '\u00dftype' },
  { location: 14, location_type: '\u{1D4B3}x' },
  { location: 15, location_type: '\u00e9mile_type' },
  { location: 1e21, location_type: 'page' },
  { location: 1e-7, location_type: 'page' },
  { location: -0.5, location_type: 'page' },
  { location: 123456789012345680000, location_type: 'page' },
  { location: null, location_type: 'page' }
]

function numbered(over: Array<Partial<ReadwiseHighlight>>, start: number): ReadwiseHighlight[] {
  return over.map((o, i) => highlight(start + i, { location: i + 1, ...o }))
}

const IMG = 'https://cdn.example.com/a.png'
const IMG_SPACE = 'https://cdn.example.com/b.png'

export const BOOK_CASES: BookCase[] = [
  { name: 'full book', book: FULL_BOOK, options: { ...base, images: [[COVER_URL, COVER_PATH]] } },
  { name: 'full book, cover not saved', book: FULL_BOOK, options: base },
  {
    name: 'full book as an article, cover saved',
    book: { ...FULL_BOOK, category: 'articles' },
    options: { ...base, images: [[COVER_URL, COVER_PATH]] }
  },
  {
    name: 'full book, cover path with a space',
    book: FULL_BOOK,
    options: { ...base, images: [[COVER_URL, 'attachments/my cover (1).jpg']] }
  },
  { name: 'tricky book', book: TRICKY_BOOK, options: base },
  { name: 'tricky book, flat', book: TRICKY_BOOK, options: { ...base, folderLayout: 'flat' } },
  {
    name: 'tricky book, tweets off',
    book: TRICKY_BOOK,
    options: { ...base, categories: { tweets: false } }
  },
  { name: 'deleted book', book: book(103, { is_deleted: true }), options: base },
  {
    name: 'deleted book without a url',
    book: book(104, { is_deleted: true, readwise_url: '' }),
    options: base
  },
  {
    name: 'supplementals off by default',
    book: book(105, { category: 'supplementals' }),
    options: base
  },
  {
    name: 'supplementals switched on',
    book: book(106, { category: ' Supplementals ' }),
    options: { ...base, categories: { supplementals: true } }
  },
  { name: 'unknown category', book: book(107, { category: 'videos' }), options: base },
  { name: 'no category', book: book(108, { category: null }), options: base },
  {
    name: 'root with slashes, empty root',
    book: book(109),
    options: { ...base, root: 'Readwise///' }
  },
  { name: 'empty root', book: book(110), options: { ...base, root: '' } },
  {
    name: 'empty root, flat',
    book: book(111),
    options: { ...base, root: '/', folderLayout: 'flat' }
  },
  {
    name: 'titles and blank metadata',
    book: book(112, {
      readable_title: '',
      title: '  Spaced Title  ',
      author: '   ',
      source: null,
      source_url: ' https://example.com/x ',
      readwise_url: null,
      book_tags: [{ name: 'Big Idea' }, { name: 'big idea' }, { name: '  ' }, { name: ' Focus ' }]
    }),
    options: base
  },
  { name: 'untitled', book: book(113, { readable_title: null, title: '   ' }), options: base },
  { name: 'empty library book', book: book(114, { highlights: null }), options: base },
  {
    name: 'document note and summary with CRLF and trailing spaces',
    book: book(115, {
      document_note: '\r\n  # Heading-like  \r\n\r\n\r\n\r\n- list-like\t \r\nend  ',
      summary: 'Summary #tag [[link]]\n\n\n\nnext'
    }),
    options: base
  },
  {
    name: 'escapes',
    book: book(116, {
      highlights: ESCAPE_TEXTS.map((text, i) =>
        highlight(1000 + i, { text, note: text, location: i })
      )
    }),
    options: base
  },
  {
    name: 'tags',
    book: book(117, {
      book_tags: TAG_NAMES.map((name) => ({ name })),
      highlights: [
        highlight(1, { tags: TAG_NAMES.map((name) => ({ name })) }),
        highlight(2, {
          tags: [{ name: '.h2' }, { name: 'focus' }],
          text: 'Heading with tags',
          note: 'n'
        }),
        highlight(3, { tags: [{ name: '\u0130stanbul' }, { name: 'istanbul' }] })
      ]
    }),
    options: base
  },
  {
    name: 'locations',
    book: book(118, { highlights: numbered(LOCATIONS, 2000) }),
    options: base
  },
  {
    name: 'a book of 101 highlights',
    book: book(128, {
      highlights: Array.from({ length: 101 }, (_, i) =>
        highlight(4000 + i, {
          text: `Highlight ${i}`,
          location: 101 - i,
          created_at: new Date(Date.UTC(2026, 9, 22, 0, i)).toISOString()
        })
      )
    }),
    options: base
  },
  ...TIME_ZONES.map((timeZone) => ({
    name: `dates in ${timeZone}`,
    book: book(119, { highlights: numbered(DATES, 3000) }),
    options: { ...base, timeZone }
  })),
  {
    name: 'image highlights, one saved, one with a space, one missing',
    book: book(120, {
      category: 'articles',
      cover_image_url: COVER_URL,
      highlights: [
        highlight(1, { text: `![](${IMG})`, created_at: '2026-10-22T18:01:00Z' }),
        highlight(2, {
          text: `  ![alt text]( <${IMG_SPACE}> )  `,
          created_at: '2026-10-22T18:02:00Z'
        }),
        highlight(3, {
          text: '![](https://cdn.example.com/missing.png)',
          created_at: '2026-10-22T18:03:00Z'
        }),
        highlight(4, { text: `![](${IMG})`, created_at: '2026-10-22T18:04:00Z' }),
        highlight(5, { text: 'plain', created_at: '2026-10-22T18:09:00Z' })
      ]
    }),
    options: {
      ...base,
      images: [
        [IMG, 'attachments/a.png'],
        [IMG_SPACE, 'attachments/b c.png']
      ]
    }
  },
  {
    name: 'heading after headings and lists',
    book: book(121, {
      highlights: [
        highlight(1, { text: 'H1', tags: [{ name: '.h1' }], location: 1 }),
        highlight(2, { text: 'H2', tags: [{ name: '.h2' }], location: 2, note: 'with note' }),
        highlight(3, { text: 'item', location: 3 }),
        highlight(4, { text: '', tags: [{ name: '.h3' }], location: 4 }),
        highlight(5, { text: 'H3', tags: [{ name: '.h3' }], location: 5 }),
        highlight(6, { text: 'next', location: 6 }),
        highlight(7, { text: 'same location, higher id', location: 6 }),
        highlight(8, { text: 'no location', location: null }),
        highlight(0, { text: 'no location, lower id', location: null }),
        highlight(9, { text: 'negative', location: -1 })
      ]
    }),
    options: base
  },
  {
    name: 'newest created at, missing and invalid dates',
    book: book(122, {
      highlights: [
        highlight(1, { created_at: null }),
        highlight(2, { created_at: 'garbage' }),
        highlight(3, { created_at: '2026-10-22T18:05:00.999Z' })
      ]
    }),
    options: base
  },
  {
    name: 'newest created at the end of time',
    book: book(123, { highlights: [highlight(1, { created_at: '+275760-09-13T00:00:00.000Z' })] }),
    options: base
  },
  {
    name: 'newest created at, no date at all',
    book: book(124, { highlights: [highlight(1, { created_at: null })] }),
    options: base
  },
  {
    name: 'astral and emoji text for UTF-16 hashing',
    book: book(125, {
      title: '\u{1F4DA}\u{1F9E0} Notes',
      highlights: [
        highlight(1, {
          text: '\u{1F600} smile \u{1F468}\u200d\u{1F469}\u200d\u{1F467} family \u{10FFFF}'
        }),
        highlight(2, { text: '\ud7ff\ue000\uffff \u{10000} edge code points', note: '\u{1F4A1}' })
      ]
    }),
    options: base
  },
  {
    name: '101 highlights',
    book: book(126, {
      highlights: Array.from({ length: 101 }, (_, i) => highlight(i + 1, { location: 101 - i }))
    }),
    options: base
  },
  {
    name: 'url fallbacks',
    book: book(127, {
      readwise_url: '',
      highlights: [highlight(1, { readwise_url: '' }), highlight(2, { readwise_url: null })]
    }),
    options: base
  }
]

export interface AppendCase {
  name: string
  highlights: ReadwiseHighlight[]
  options: {
    last: string | null
    noteCreated: string
    linkedIds: number[]
    timeZone: string
    images?: Images
  }
}

const appendHighlights = [
  highlight(1, { created_at: '2026-10-20T00:00:00Z' }),
  highlight(2, { created_at: '2026-10-21T00:00:00Z' }),
  highlight(3, { created_at: '2026-10-22T00:00:00Z' }),
  highlight(4, { created_at: '2026-10-22T00:00:00.001Z' }),
  highlight(5, { created_at: null }),
  highlight(6, { created_at: '2026-10-23T00:00:00Z', is_deleted: true }),
  highlight(7, { created_at: '2026-10-23T00:00:00Z', tags: [{ name: '.h1' }] }),
  highlight(8, { created_at: '2026-10-19T00:00:00Z', text: `![](${IMG})` }),
  highlight(9, {
    created_at: '2026-10-21T12:00:00Z',
    text: '![](https://cdn.example.com/missing.png)'
  })
]

const appendBase = { noteCreated: '2026-10-21T06:00:00.000Z', timeZone: 'UTC' }

export const APPEND_CASES: AppendCase[] = [
  {
    name: 'last usable, nothing linked',
    highlights: appendHighlights,
    options: { ...appendBase, last: '2026-10-22T00:00:00.000Z', linkedIds: [] }
  },
  {
    name: 'last usable, some linked',
    highlights: appendHighlights,
    options: { ...appendBase, last: '2026-10-22T00:00:00.001Z', linkedIds: [1, 2, 3] }
  },
  {
    name: 'last usable, image saved',
    highlights: appendHighlights,
    options: {
      ...appendBase,
      last: '2026-10-18T00:00:00.000Z',
      linkedIds: [],
      images: [[IMG, 'attachments/a.png']]
    }
  },
  {
    name: 'no last, floor from linked',
    highlights: appendHighlights,
    options: { ...appendBase, last: null, linkedIds: [2] }
  },
  {
    name: 'no last, nothing linked',
    highlights: appendHighlights,
    options: { ...appendBase, last: null, linkedIds: [] }
  },
  {
    name: 'unparsable last',
    highlights: appendHighlights,
    options: { ...appendBase, last: 'x', linkedIds: [4] }
  },
  {
    name: 'no last, unparsable note creation',
    highlights: appendHighlights,
    options: { ...appendBase, noteCreated: 'garbage', last: null, linkedIds: [] }
  },
  {
    name: 'everything linked',
    highlights: appendHighlights,
    options: { ...appendBase, last: '2026-10-25T00:00:00.000Z', linkedIds: [1, 2, 3, 4, 5, 8, 9] }
  },
  {
    name: 'empty',
    highlights: [],
    options: { ...appendBase, last: '2026-10-25T00:00:00.000Z', linkedIds: [] }
  },
  { name: 'empty, no last', highlights: [], options: { ...appendBase, last: null, linkedIds: [] } },
  {
    name: 'time zone of the day',
    highlights: [
      highlight(1, { created_at: '2026-10-22T23:30:00Z', highlighted_at: '2026-10-22T23:30:00Z' })
    ],
    options: { ...appendBase, last: null, linkedIds: [], timeZone: 'Asia/Kolkata' }
  }
]

export const LINKED_MARKDOWN = [
  '- a ([Location 10](https://readwise.io/open/1))\n- b ([Page 2](https://readwise.io/open/22), 2026-10-22)',
  'readwise.io/open/007 and readwise.io/open/7 and readwise.io/open/ and readwise.io/open/12x3',
  'readwise_io/open/5 and readwiseXio/open/6',
  'readwise.io/open/99999999999999999999 readwise.io/open/9007199254740993',
  ''
]

export const IMAGE_TEXTS = [
  '![](https://cdn.example.com/a.png)',
  '  ![alt](  <https://cdn.example.com/a b.png>  )  ',
  '![alt](<https://cdn.example.com/a.png>)',
  '![alt](<https://cdn.example.com/a.png)',
  '![alt](https://cdn.example.com/a.png>)',
  '![alt](https://cdn.example.com/a.png )',
  '![alt](https://cdn.example.com/a.png) trailing',
  '![a]b](https://x)',
  '![](<>)',
  '![]()',
  '![multi\nline](https://cdn.example.com/a.png)',
  '![](https://cdn.example.com/(paren).png)',
  '!(https://x)',
  'text'
]

export const HASH_INPUTS = [
  '',
  'a',
  'Hello, world',
  'line one\r\nline two\rline three\n',
  'trailing spaces   \ntrailing tab\t\t\nnbsp\u00a0\n',
  '\n\n\nleading and trailing newlines\n\n\n',
  '\r\n\r\nCRLF edges\r\n\r\n',
  ' \n leading space line',
  '\u{1F600}\u{1F4DA}\u{10FFFF}',
  '\ud7ff\ue000\uffff'
]

/** A 200 KB body, built from a unit the Rust test repeats the same way. */
export const BIG_HASH = { unit: 'ab\u{1F600} \r\n- [x] item\t\n', times: 8_000 }

const SECTION = `<!-- readwise:start -->\n\n## Highlights\n\n- a\n\n<!-- readwise:end v1 last=2026-10-22T18:05:00.001Z hash=00000000 -->`

export const BODIES: Array<{ name: string; body: string }> = [
  { name: 'empty', body: '' },
  { name: 'plain text', body: 'Just a note.' },
  { name: 'sealed with emoji', body: '## Highlights\n\n- \u{1F600} smile' },
  { name: 'sealed with CRLF', body: '## Highlights\r\n\r\n- a  \r\n- b' },
  { name: 'sealed with outer newlines', body: '\n\n## Highlights\n\n- a\n\n' },
  { name: 'sealed with trailing spaces', body: '## Highlights   \n\n- a\t' },
  { name: 'unsealed hash mismatch', body: `Intro\n\n${SECTION}\n\nOutro` },
  {
    name: 'no start',
    body: 'Intro\n<!-- readwise:end v1 last=2026-10-22T18:05:00.001Z hash=00000000 -->'
  },
  { name: 'no end', body: '<!-- readwise:start -->\n\ntext' },
  {
    name: 'out of order',
    body: '<!-- readwise:end v1 last=x hash=0 -->\ntext\n<!-- readwise:start -->'
  },
  {
    name: 'inline marker',
    body: 'see <!-- readwise:start --> inline\n<!-- readwise:start -->\n<!-- readwise:end v1 last=x hash=0 -->'
  },
  {
    name: 'inline end prefix',
    body: '<!-- readwise:start -->\nx <!-- readwise:end\n<!-- readwise:end v1 last=x hash=0 -->'
  },
  {
    name: 'duplicate starts',
    body: '<!-- readwise:start -->\n<!-- readwise:start -->\n<!-- readwise:end v1 last=x hash=0 -->'
  },
  {
    name: 'duplicate ends',
    body: '<!-- readwise:start -->\n<!-- readwise:end v1 last=x hash=0 -->\n<!-- readwise:end v1 last=y hash=1 -->'
  },
  {
    name: 'unknown version',
    body: '<!-- readwise:start -->\n\n- a\n\n<!-- readwise:end v2 last=x hash=6f2bc5ea -->'
  },
  {
    name: 'version 01',
    body: '<!-- readwise:start -->\n\n- a\n\n<!-- readwise:end v01 last=x hash=6f2bc5ea -->'
  },
  {
    name: 'bad fields',
    body: '<!-- readwise:start -->\n\n- a\n\n<!-- readwise:end v1  last=x hash=6f2bc5ea -->'
  },
  {
    name: 'uppercase hash',
    body: '<!-- readwise:start -->\n\n- a\n\n<!-- readwise:end v1 last=x hash=ABC -->'
  },
  {
    name: 'indented and CRLF markers',
    body: '  <!-- readwise:start -->  \r\n\r\n- a\r\n\r\n\t<!-- readwise:end v1 last=x hash=00000000 -->\r\nafter'
  },
  {
    name: 'adjacent markers',
    body: '<!-- readwise:start -->\n<!-- readwise:end v1 last=x hash=811c9dc5 -->'
  },
  {
    name: 'markers with astral text before',
    body: '\u{1F600}\u{1F600}\n<!-- readwise:start -->\n\u{1F4DA}\n<!-- readwise:end v1 last=x hash=0 -->\n\u{1F600}'
  },
  {
    name: 'nbsp-indented marker',
    body: '\u00a0<!-- readwise:start -->\n\n<!-- readwise:end v1 last=x hash=811c9dc5 -->'
  },
  {
    name: 'nel-indented marker',
    body: '\u0085<!-- readwise:start -->\n\n<!-- readwise:end v1 last=x hash=811c9dc5 -->'
  },
  {
    name: 'day markers are not book markers',
    body: '<!-- readwise-day:start -->\n<!-- readwise-day:end v1 hash=0 -->'
  }
]

const deepWork: JournalBook = { title: 'Deep Work', count: 2, first: '2026-10-22T08:00:00.000Z' }
const DAY_SECTION = planJournalDay([deepWork])

export const DAY_BODIES: Array<{ name: string; body: string }> = [
  { name: 'empty', body: '' },
  { name: 'text only', body: 'Morning pages.\n' },
  { name: 'text ending in a list', body: 'Todo:\n- one\n- two\n\n' },
  { name: 'untouched', body: `Morning.\n\n${DAY_SECTION}\n\nEvening.` },
  {
    name: 'untouched, older books',
    body: planJournalDay([{ title: 'Old', count: 1, first: '2026-10-22T07:00:00.000Z' }])
  },
  {
    name: 'touched',
    body: `Morning.\n\n${DAY_SECTION.replace('2 highlights', '2 highlights, edited')}\n\nEvening.`
  },
  {
    name: 'touched ending in text',
    body: '<!-- readwise-day:start -->\n\n### Readwise\n\nmy words\n<!-- readwise-day:end v1 hash=00000000 -->'
  },
  {
    name: 'unknown version',
    body: '<!-- readwise-day:start -->\n\nx\n\n<!-- readwise-day:end v2 hash=0 -->'
  },
  { name: 'end only', body: 'text\n\n- item\n<!-- readwise-day:end v1 hash=0 -->\n' },
  { name: 'end only, unknown version', body: 'text\n<!-- readwise-day:end v9 hash=0 -->' },
  { name: 'start only', body: '<!-- readwise-day:start -->\n\n- x  \n\n' },
  {
    name: 'out of order',
    body: '<!-- readwise-day:end v1 hash=0 -->\n<!-- readwise-day:start -->'
  },
  { name: 'inline', body: 'a <!-- readwise-day:start --> b' },
  {
    name: 'duplicate',
    body: '<!-- readwise-day:start -->\n<!-- readwise-day:start -->\n<!-- readwise-day:end v1 hash=0 -->'
  },
  {
    name: 'book markers only',
    body: '<!-- readwise:start -->\n<!-- readwise:end v1 last=x hash=0 -->'
  },
  { name: 'numbered list before end', body: 'x\n  12) item\n<!-- readwise-day:end v1 hash=0 -->' },
  {
    name: 'ten-digit list before end',
    body: 'x\n1234567890. item\n<!-- readwise-day:end v1 hash=0 -->'
  },
  { name: 'astral before end', body: '\u{1F600}\n<!-- readwise-day:end v1 hash=0 -->\n\u{1F600}' }
]

export interface JournalCase {
  name: string
  day: JournalBook[]
  arrivals: JournalBook[]
}

export const JOURNAL_CASES: JournalCase[] = [
  { name: 'one book', day: [deepWork], arrivals: [{ ...deepWork, count: 1 }] },
  {
    name: 'ordering and counts',
    day: [
      { title: 'B', count: 1, first: '2026-10-22T09:00:00.000Z' },
      { title: 'A', count: 3, first: '2026-10-22T09:00:00.000Z' },
      { title: 'Zero', count: 0, first: '2026-10-22T01:00:00.000Z' },
      { title: '\uff21 fullwidth', count: 1, first: '2026-10-22T10:00:00.000Z' },
      { title: '\u{1F600} emoji', count: 1, first: '2026-10-22T10:00:00.000Z' },
      deepWork
    ],
    arrivals: [{ title: 'A', count: 1, first: '2026-10-22T09:00:00.000Z' }]
  },
  { name: 'no arrivals', day: [deepWork], arrivals: [] },
  { name: 'nothing', day: [], arrivals: [] },
  {
    name: 'only zero counts',
    day: [{ ...deepWork, count: 0 }],
    arrivals: [{ ...deepWork, count: 0 }]
  }
]

export const JOURNAL_TITLES = [
  'Plain',
  'a [b] c | d',
  'x <!-- y --> z',
  '<!--<!--',
  '[[nested]]',
  '   ',
  '',
  'line\nbreak\ttab',
  '\u{1F4DA} books'
]

export const HIGHLIGHT_DATES: Array<{
  dates: { highlightedAt?: string | null; createdAt?: string | null }
  timeZone: string
}> = TIME_ZONES.flatMap((timeZone) =>
  DATES.map((d) => ({
    dates: { highlightedAt: d.highlighted_at, createdAt: d.created_at },
    timeZone
  }))
)
