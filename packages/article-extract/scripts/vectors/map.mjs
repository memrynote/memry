// Vectors of `mapToArticleCapture`: the mapping from Defuddle's result to an ArticleCapture.
import { mapToArticleCapture } from '../../src/map.ts'

const long = (length, filler = 'word ') =>
  filler.repeat(Math.ceil(length / filler.length)).slice(0, length)
const emoji = '\u{1f600}'

const cases = [
  {
    name: 'full article',
    result: {
      content: long(500),
      title: ' Title ',
      author: ' Ann ',
      published: '2024-01-02',
      description: ' About ',
      image: ' https://e.com/i.png ',
      wordCount: 100
    }
  },
  {
    name: 'partial under the threshold',
    result: { content: 'short text', title: 'T', wordCount: 99 }
  },
  {
    name: 'failed on blank content',
    result: { content: ' \u00a0\ufeff\n', title: 'T', wordCount: 500 }
  },
  { name: 'failed on missing content', result: { title: 'T' } },
  { name: 'missing word count counts as zero', result: { content: 'x' } },
  { name: 'title falls back to the url', result: { content: 'x', title: '  ' } },
  {
    name: 'untrimmed unicode whitespace in title',
    result: { content: 'x', title: '\ufeff\u00a0Name\u2028' }
  },
  {
    name: 'blank optional fields are dropped',
    result: { content: 'x', author: ' ', published: '\n', description: '\t', image: ' ' }
  },
  {
    name: 'excerpt is the description',
    result: { content: long(400), description: '  Summary  ' }
  },
  { name: 'excerpt is 200 code units of content', result: { content: long(400) } },
  { name: 'excerpt of short content', result: { content: 'tiny' } },
  { name: 'excerpt keeps leading whitespace', result: { content: '  # Heading\n\ntext' } },
  { name: 'excerpt at an astral boundary', result: { content: long(199) + emoji + 'tail' } },
  { name: 'excerpt ends on an astral character', result: { content: long(198) + emoji + 'tail' } },
  { name: 'empty result', result: {} },
  {
    name: 'key order of optional properties',
    result: { content: 'x', description: 'd', published: 'p', author: 'a' }
  }
]

export function mapVector() {
  const url = 'https://example.com/post?a=1'
  const now = '2025-03-04T05:06:07.000Z'
  return cases.map(({ name, result }) => {
    const expected = mapToArticleCapture(result, url, { now })
    return {
      name,
      input: { result, url, now },
      // A split surrogate pair cannot be held by a Rust string. The port produces U+FFFD there.
      expected: JSON.parse(
        JSON.stringify(expected, (_key, value) =>
          typeof value === 'string' ? value.toWellFormed() : value
        )
      )
    }
  })
}
