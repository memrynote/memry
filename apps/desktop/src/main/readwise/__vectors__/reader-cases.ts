/** Reader inputs of the Readwise vectors (`readwise-vectors.test.ts`), split from `cases.ts`. */
import type { FolderLayout } from '@memry/importers/readwise'
import { COVER_PATH, COVER_URL } from '@memry/importers/readwise/fixtures'
import type { Images } from './cases'

export interface ReaderCase {
  name: string
  document: Record<string, unknown>
  options: {
    root: string
    folderLayout: FolderLayout
    images?: Images
    fullText?: string | null
    bookExternalIds?: string[]
  }
}

const readerBase = { root: 'Readwise', folderLayout: 'by-category' as FolderLayout }
const doc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'doc1',
  url: 'https://read.readwise.io/read/doc1',
  title: 'Why notes compound',
  author: ' Jane Doe ',
  source: 'Reader RSS',
  category: 'Article',
  location: 'new',
  tags: { focus: { name: 'focus' }, 'Big Idea': { name: '' } },
  site_name: 'example.com',
  word_count: 1234,
  published_date: '2026-10-01',
  summary: 'A summary #tag',
  image_url: COVER_URL,
  source_url: 'https://example.com/post',
  notes: 'My note\r\n\r\n\r\nmore',
  parent_id: null,
  ...over
})

export const READER_CASES: ReaderCase[] = [
  {
    name: 'article, cover saved',
    document: doc(),
    options: { ...readerBase, images: [[COVER_URL, COVER_PATH]], fullText: '  # Full text  \n\n' }
  },
  { name: 'article, cover missing', document: doc(), options: readerBase },
  {
    name: 'email, cover saved',
    document: doc({ category: 'email' }),
    options: { ...readerBase, images: [[COVER_URL, COVER_PATH]] }
  },
  { name: 'child', document: doc({ parent_id: 'p1' }), options: readerBase },
  { name: 'empty parent id', document: doc({ parent_id: '' }), options: readerBase },
  { name: 'feed', document: doc({ location: 'feed' }), options: readerBase },
  { name: 'has a book', document: doc(), options: { ...readerBase, bookExternalIds: ['doc1'] } },
  {
    name: 'bare',
    document: { id: 'doc2' },
    options: { ...readerBase, folderLayout: 'flat', fullText: '   ' }
  },
  {
    name: 'integer-like tag keys',
    document: doc({
      tags: {
        b: { name: 'b' },
        '2': { name: null },
        a: {},
        '1': { name: 'one' },
        '01': { name: '' },
        '4294967295': { name: '' },
        '4294967294': { name: '' },
        '-1': { name: '' },
        B: { name: 'B' }
      }
    }),
    options: readerBase
  },
  { name: 'published seconds', document: doc({ published_date: 1761000000 }), options: readerBase },
  {
    name: 'published millis',
    document: doc({ published_date: 1761000000123 }),
    options: readerBase
  },
  {
    name: 'published fraction',
    document: doc({ published_date: 1761000000.9 }),
    options: readerBase
  },
  { name: 'published negative', document: doc({ published_date: -86400.5 }), options: readerBase },
  { name: 'published out of range', document: doc({ published_date: 9e15 }), options: readerBase },
  {
    name: 'published extended year',
    document: doc({ published_date: 8.64e15 }),
    options: readerBase
  },
  { name: 'published zero', document: doc({ published_date: 0 }), options: readerBase },
  { name: 'published blank', document: doc({ published_date: '   ' }), options: readerBase },
  {
    name: 'word count zero and fraction',
    document: doc({ word_count: 0, site_name: '  ' }),
    options: readerBase
  },
  { name: 'word count fraction', document: doc({ word_count: 12.5 }), options: readerBase },
  {
    name: 'no url, blank title',
    document: doc({ url: '', title: '  ', category: null, tags: null }),
    options: { ...readerBase, root: 'R/' }
  }
]

export const READER_FULL_TEXT_CASES: Array<{ name: string; html: string; baseUrl?: string }> = [
  {
    name: 'html-heavy article',
    html: `
<h1>Why notes compound</h1>
<p>First <strong>paragraph</strong> with a <a href="https://example.com/a">link</a> and <em>emphasis</em>.</p>
<img src="https://cdn.example.com/hero.jpg" alt="hero">
<blockquote><p>A quote worth keeping.</p></blockquote>
<h2>Steps</h2>
<ol><li>Capture</li><li>Connect <code>links</code></li></ol>
<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
<pre><code>const x = 1</code></pre>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<script>alert(1)</script>
`
  },
  {
    name: 'figure with caption',
    html:
      '<figure><img alt="Notes in MemryNote" src="https://cdn.example.com/n.webp" srcset="https://cdn.example.com/n-1100.webp 1100w,"/><figcaption>Notes in MemryNote</figcaption></figure>' +
      '<figure><img alt="No caption" src="https://cdn.example.com/b.webp"/></figure>'
  },
  {
    name: 'lazy sources',
    html: [
      '<img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example.com/lazy.png">',
      '<img srcset="/img/small.png 400w, /img/large.png 1200w">',
      '<picture><source srcset="https://cdn.example.com/p.webp 2x"><img></picture>',
      '<img src="blob:nope">'
    ].join(''),
    baseUrl: 'https://example.com/post/1'
  },
  {
    name: 'local hosts',
    html: [
      'http://127.0.0.1:8080/a.png',
      'http://localhost/b.png',
      'http://192.168.1.5/c.png',
      'http://169.254.169.254/d.png',
      'http://[::1]/e.png',
      'file:///etc/passwd',
      'https://cdn.example.com/ok.png'
    ]
      .map((src) => `<img src="${src}">`)
      .join('')
  },
  {
    name: 'image cap',
    html: Array.from({ length: 80 }, (_, i) => `<img src="https://cdn.example.com/${i}.png">`).join(
      ''
    )
  }
]

export const IMAGE_URLS = [
  COVER_URL,
  'https://cdn.example.com/a.png?w=100&h=200',
  'https://cdn.example.com/\u00fcml\u00e4ut/\u{1F600}.png',
  'http://x',
  ''
]
