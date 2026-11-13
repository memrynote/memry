/**
 * Class: embedding-input (`embedding-input.json`).
 *
 * Desktop's own shaping, imported for real: `buildEmbeddingInput` (document
 * task), `buildEmbeddingChunks` and `buildQueryEmbeddingInput` from
 * `apps/desktop/src/main/lib/embedding-input.ts`. Each case records the text
 * desktop feeds the model for a title and content, or for a query.
 *
 * Desktop cuts in UTF-16 code units, so a cut can split a surrogate pair. The
 * expected text goes through `toWellFormed()`, which turns each lone surrogate
 * into U+FFFD: JSON cannot carry one, and a phone's string cannot hold one.
 *
 * Chapter: docs/protocol/15-embedding-input.md.
 */
// A namespace import: desktop's sources are CommonJS to Node, and the ESM
// loader cannot see their named exports statically.
import * as embeddingInput from '../../../../apps/desktop/src/main/lib/embedding-input.ts'

type EmbeddingInputModule = typeof embeddingInput

const shaping: EmbeddingInputModule =
  (embeddingInput as EmbeddingInputModule & { default?: EmbeddingInputModule }).default ??
  embeddingInput

interface NoteCase {
  readonly name: string
  readonly pins: string
  readonly title: string
  readonly content: string
}

interface QueryCase {
  readonly name: string
  readonly pins: string
  readonly query: string
}

const SENTENCE = 'The quick brown fox jumps over the lazy dog. '
const HEADER = 'title: Long | text: '
/** The chunk budget for the title `Long`: 4000 minus the header. */
const BUDGET = 4000 - HEADER.length

/** `count` units of `x`, no separator anywhere. */
const run = (count: number, unit = 'x'): string => unit.repeat(count)

/** A body just over the budget whose only separator sits at code unit `at`. */
function separatorAt(separator: string, at: number, budget = BUDGET): string {
  return `${run(at)}${separator}${run(budget - at + 50)}`
}

const NOTE_CASES: readonly NoteCase[] = [
  { name: 'empty', pins: 'nothing to embed', title: '', content: '' },
  { name: 'under the minimum', pins: '9 units in all', title: 'abcd', content: 'efghi' },
  {
    name: 'exactly the minimum',
    pins: '10 units in all is embedded',
    title: 'abcde',
    content: 'fghij'
  },
  {
    name: 'title only',
    pins: 'the head window keeps an empty body',
    title: 'A title only note',
    content: ''
  },
  {
    name: 'untitled',
    pins: 'an empty title reads `none`',
    title: '   ',
    content: 'Body text without a title.'
  },
  {
    name: 'title over 200 units',
    pins: 'chunks cut the title at 200 units, the document input does not',
    title: run(250, 'T'),
    content: 'Short body.'
  },
  {
    name: 'fits one window exactly',
    pins: 'a body of exactly the budget is one window',
    title: 'Long',
    content: run(BUDGET)
  },
  {
    name: 'paragraph break past half',
    pins: '`\\n\\n` at or after budget/2 cuts after it',
    title: 'Long',
    content: separatorAt('\n\n', Math.ceil(BUDGET / 2))
  },
  {
    name: 'paragraph break before half',
    pins: '`\\n\\n` before budget/2 is ignored, so the cut is hard',
    title: 'Long',
    content: separatorAt('\n\n', Math.ceil(BUDGET / 2) - '\n\n'.length)
  },
  {
    name: 'line break past half',
    pins: '`\\n` at or after budget/2',
    title: 'Long',
    content: separatorAt('\n', Math.ceil(BUDGET / 2))
  },
  {
    name: 'line break before half',
    pins: '`\\n` before budget/2 is ignored',
    title: 'Long',
    content: separatorAt('\n', Math.ceil(BUDGET / 2) - '\n'.length)
  },
  {
    name: 'sentence break past half',
    pins: '`. ` at or after budget/2',
    title: 'Long',
    content: separatorAt('. ', Math.ceil(BUDGET / 2))
  },
  {
    name: 'sentence break before half',
    pins: '`. ` before budget/2 is ignored',
    title: 'Long',
    content: separatorAt('. ', Math.ceil(BUDGET / 2) - '. '.length)
  },
  {
    name: 'word break past half',
    pins: '` ` at or after budget/2',
    title: 'Long',
    content: separatorAt(' ', Math.ceil(BUDGET / 2))
  },
  {
    name: 'word break before half',
    pins: '` ` before budget/2 is ignored',
    title: 'Long',
    content: separatorAt(' ', Math.ceil(BUDGET / 2) - ' '.length)
  },
  {
    name: 'odd budget',
    pins: 'budget/2 is not floored: 3979 / 2 = 1989.5, so a space at 1989 is ignored',
    title: 'Longs',
    content: separatorAt(' ', 1989, 4000 - 'title: Longs | text: '.length)
  },
  {
    name: 'separator order',
    pins: '`\\n\\n` wins over a later `\\n` when both are past half',
    title: 'Long',
    content: `${run(BUDGET - 100)}\n\n${run(50)}\n${run(50)}`
  },
  {
    name: 'no separator',
    pins: 'a hard cut at the budget',
    title: 'Long',
    content: run(BUDGET * 2 + 7)
  },
  {
    name: 'more than 16 windows',
    pins: 'the note stops at 16 windows',
    title: 'Long',
    content: SENTENCE.repeat(Math.ceil((BUDGET * 17) / SENTENCE.length))
  },
  {
    name: 'sliver last window',
    pins: 'a later piece under 10 units is dropped',
    title: 'Long',
    content: `${run(BUDGET)} tail`
  },
  {
    name: 'emoji at the cut',
    pins: 'a hard cut through a surrogate pair gives U+FFFD on both sides',
    title: 'Long',
    content: `${run(BUDGET - 1)}😀${run(50)}`
  },
  {
    name: 'CJK Extension B at the cut',
    pins: 'U+20000 split by a hard cut',
    title: 'Long',
    content: `${run(BUDGET - 1)}\u{20000}${run(50)}`
  },
  {
    name: 'surrogate pair just inside the cut',
    pins: 'a pair that ends at the budget stays whole',
    title: 'Long',
    content: `${run(BUDGET - 2)}😀${run(50)}`
  },
  {
    name: 'title cut through a surrogate pair',
    pins: 'the 200-unit title cut splits an emoji',
    title: `${run(199, 'T')}😀 more`,
    content: 'Body text for the split title.'
  },
  {
    name: 'document input over the limit',
    pins: 'the document input is cut at 4000 units',
    title: 'Long',
    content: run(5000)
  },
  {
    name: 'BOM trimmed',
    pins: 'U+FEFF is JS whitespace',
    title: '\uFEFFTitle\uFEFF',
    content: '\uFEFFBody text here\uFEFF'
  },
  {
    name: 'NEL kept',
    pins: 'U+0085 is not JS whitespace',
    title: '\u0085Title\u0085',
    content: '\u0085Body text here\u0085'
  },
  {
    name: 'NBSP and ideographic space trimmed',
    pins: 'U+00A0 and U+3000 are JS whitespace',
    title: '\u00A0Title\u3000',
    content: '\u00A0\u2028Body text here\u2029\u3000'
  },
  {
    name: 'trims around a cut',
    pins: 'each piece is trimmed on both sides of the cut',
    title: 'Long',
    content: `${run(BUDGET - 10)}   \n\n   ${run(50)}`
  },
  {
    name: 'Turkish text',
    pins: 'non-ASCII BMP text counts one unit per character',
    title: 'Çalışma notları',
    content: 'Işık, ğüşöç ve İstanbul. '.repeat(400)
  }
]

const QUERY_CASES: readonly QueryCase[] = [
  { name: 'empty', pins: 'no input', query: '' },
  { name: 'blank', pins: 'whitespace only is no input', query: ' \u00A0\uFEFF\n' },
  { name: 'trimmed', pins: 'the query is trimmed', query: '  meeting notes  ' },
  { name: 'NEL kept', pins: 'U+0085 is not trimmed', query: '\u0085q\u0085' },
  { name: 'Turkish', pins: 'non-ASCII text', query: 'ılık İzmir' },
  { name: 'over the limit', pins: 'prefix plus query cut at 4000 units', query: run(5000, 'q') },
  {
    name: 'emoji at the limit',
    pins: 'a cut through a surrogate pair gives U+FFFD',
    query: `${run(4000 - 'task: search result | query: '.length - 1, 'q')}😀`
  }
]

const wellFormed = (text: string): string => text.toWellFormed()

export function buildEmbeddingInput(): Record<string, unknown> {
  return {
    description:
      "The text desktop's `embedding-input.ts` feeds the model for each note (`document`, `chunks`) and query. Lengths count UTF-16 code units; a lone surrogate left by a cut is U+FFFD.",
    meta: {
      class: 'embedding-input',
      inputVersion: shaping.EMBEDDING_INPUT_VERSION,
      maxInputUnits: shaping.MAX_EMBEDDING_INPUT_LENGTH,
      maxWindows: shaping.MAX_EMBEDDING_CHUNKS,
      caseCount: NOTE_CASES.length + QUERY_CASES.length
    },
    cases: NOTE_CASES.map((c) => {
      const document = shaping.buildEmbeddingInput(
        { title: c.title, content: c.content },
        'document'
      )
      return {
        ...c,
        expected: {
          document: document ? wellFormed(document) : null,
          chunks: shaping
            .buildEmbeddingChunks({ title: c.title, content: c.content })
            .map(wellFormed)
        }
      }
    }),
    queries: QUERY_CASES.map((c) => {
      const input = shaping.buildQueryEmbeddingInput(c.query)
      return { ...c, expected: input ? wellFormed(input) : null }
    })
  }
}
