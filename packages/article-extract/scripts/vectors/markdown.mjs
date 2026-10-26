// Markdown vectors: `createMarkdownContent` of `dist/markdown.js` (turndown 7.2.4 with
// Defuddle's rules) and `buildFrontmatter` of `dist/frontmatter.js`.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dist } from './probes.mjs'

const require = createRequire(join(dist, 'x.js'))
const { createMarkdownContent } = require('./markdown.js')
const { buildFrontmatter } = require('./frontmatter.js')

/** `createMarkdownContent(html)` as `toMarkdown` calls it, on well-formed text. */
export function markdownVector(html) {
  const wellFormed = html.toWellFormed()
  return {
    html: wellFormed,
    markdown: createMarkdownContent(wellFormed, '').toWellFormed()
  }
}

const results = [
  {},
  { title: 'Plain title' },
  { title: 'A "quoted"\ntitle', author: 'Jo "J" Smith\nSecond line', site: 'Site "S"' },
  {
    title: 'T',
    author: 'A',
    site: 'S',
    published: '2024-01-02T03:04:05+00:00',
    domain: 'example.com',
    language: 'en',
    description: 'Short "desc"\nwith newline',
    wordCount: 1234
  },
  { description: 'word '.repeat(300) },
  { description: 'word '.repeat(301) },
  { description: `${'word '.repeat(299)}word  tail words` },
  { description: '漢字'.repeat(160) },
  { description: '漢字'.repeat(151) },
  { description: `${'ひらがな カタカナ 한국어 '.repeat(60)}end` },
  { description: 'x'.repeat(50000) },
  { description: 'a b '.repeat(310).trimEnd() },
  { description: 'tab\tsep\nnl '.repeat(200) },
  { description: 'emoji 😀 '.repeat(200) },
  { wordCount: 0, title: 'Zero' },
  { wordCount: 7 },
  { published: '2020-05-06', language: 'fr-CA', domain: 'a.b.c' },
  { title: '', author: '', site: '', description: '' }
]
const sources = [undefined, '', 'https://example.com/a?b="c"']

export function frontmatterProbes() {
  return results.flatMap((result) =>
    sources.map((sourceUrl) => ({
      result,
      sourceUrl: sourceUrl ?? null,
      expected: buildFrontmatter(result, sourceUrl).toWellFormed()
    }))
  )
}
