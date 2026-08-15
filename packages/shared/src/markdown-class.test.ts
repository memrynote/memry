import { describe, expect, it } from 'vitest'
import {
  NOTE_MAX_BYTES,
  NOTE_MAX_BLOCK_BYTES,
  utf8ByteLength,
  largestBlockByteLength,
  classifyMarkdownStat,
  classifyMarkdownContent,
  type MarkdownClassThresholds
} from './markdown-class'

// Small thresholds keep the table readable; the real constants are asserted
// separately so a calibration change has to be deliberate.
const TINY: MarkdownClassThresholds = { maxFileBytes: 100, maxBlockBytes: 20 }

// ---------------------------------------------------------------------------
// utf8ByteLength
// ---------------------------------------------------------------------------

describe('utf8ByteLength', () => {
  const cases: Array<[name: string, text: string, bytes: number]> = [
    ['empty string', '', 0],
    ['ascii', 'hello', 5],
    ['newlines count', 'a\nb\n', 4],
    ['2-byte latin', 'é', 2],
    ['2-byte cyrillic', 'привет', 12],
    ['3-byte CJK', '日本語', 9],
    ['4-byte astral emoji', '😀', 4],
    ['mixed', 'a é 日 😀', 1 + 1 + 2 + 1 + 3 + 1 + 4],
    ['lone surrogate is 3 bytes', '\ud800', 3]
  ]

  it.each(cases)('%s', (_name, text, bytes) => {
    // #given / #when / #then — matches what Buffer.byteLength would report
    expect(utf8ByteLength(text)).toBe(bytes)
  })

  it('agrees with TextEncoder across the table', () => {
    const encoder = new TextEncoder()
    for (const [, text] of cases) {
      // A lone surrogate encodes to U+FFFD (3 bytes) either way.
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).length)
    }
  })
})

// ---------------------------------------------------------------------------
// largestBlockByteLength
// ---------------------------------------------------------------------------

describe('largestBlockByteLength', () => {
  const cases: Array<[name: string, markdown: string, largest: number]> = [
    ['empty', '', 0],
    ['single line', 'hello', 5],
    ['single paragraph keeps its newline', 'ab\ncd', 5],
    ['two blocks -> the larger one', 'ab\n\nlonger block', 12],
    ['blank line is not counted into either block', 'aaa\n\nbb', 3],
    ['run of blank lines collapses', 'aaa\n\n\n\nbb', 3],
    ['whitespace-only line separates', 'aaa\n   \nbb', 3],
    ['tab-only line separates', 'aaa\n\t\nbb', 3],
    ['CRLF blank line separates', 'aaa\r\n\r\nbb', 4],
    ['leading blank lines ignored', '\n\nhello', 5],
    ['trailing blank lines ignored', 'hello\n\n', 5],
    ['no blank lines at all -> whole file is one block', 'a\nb\nc\nd', 7],
    ['multibyte counted as bytes not chars', '日本語', 9],
    ['first block can be the largest', 'aaaaaaaa\n\nbb', 8],
    // Shapes the #1463 corpus surfaced. Each is a whole document that reads as
    // ONE block, which is what the block bound is measuring.
    ['tight list (roam/bear export) is one block', '- a\n  - b\n- c', 13],
    ['markdown table is one block', '| a | b |\n| - | - |\n| 1 | 2 |', 29],
    ['minified json on one line is one block', '[{"id":1},{"id":2}]', 19],
    ['frontmatter is its own block', '---\ntitle: x\n---\n\nbody', 16],
    // Deliberate under-report: remark keeps a fence whole, this scan splits it.
    // Safe, because the cost this bound tracks is inline parsing and a fence
    // carries no inline nodes.
    ['blank line inside a code fence still splits', '```\naa\n\nbbbb\n```', 8]
  ]

  it.each(cases)('%s', (_name, markdown, largest) => {
    expect(largestBlockByteLength(markdown)).toBe(largest)
  })

  it('is the whole body for a log dump with no blank lines', () => {
    // #given — 500 lines, no blank line anywhere, which is the log-dump shape
    const dump = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')

    // #when / #then — one block, so the block bound sees the whole file
    expect(largestBlockByteLength(dump)).toBe(utf8ByteLength(dump))
  })

  it('is a small fraction of the file for well-formed prose', () => {
    // #given — same byte budget, but blank-line separated
    const prose = Array.from({ length: 500 }, (_, i) => `paragraph ${i}`).join('\n\n')

    // #when
    const largest = largestBlockByteLength(prose)

    // #then — no single block is anywhere near the whole file
    expect(largest).toBeLessThan(utf8ByteLength(prose) / 100)
  })
})

// ---------------------------------------------------------------------------
// classifyMarkdownStat — size alone, before any read
// ---------------------------------------------------------------------------

describe('classifyMarkdownStat', () => {
  it('returns null when the byte ceiling does not settle it', () => {
    // #given a file under the ceiling
    // #when / #then — the block bound still has to be measured, so no verdict
    expect(classifyMarkdownStat(100, TINY)).toBeNull()
  })

  it('classifies an over-ceiling file without reading it', () => {
    // #given a file over the ceiling
    // #when
    const result = classifyMarkdownStat(101, TINY)

    // #then — largestBlockBytes stays null: the file was never read
    expect(result).toEqual({
      sizeClass: 'large-file',
      reason: 'file-bytes',
      fileBytes: 101,
      largestBlockBytes: null
    })
  })

  it('treats the ceiling as inclusive', () => {
    expect(classifyMarkdownStat(NOTE_MAX_BYTES)).toBeNull()
    expect(classifyMarkdownStat(NOTE_MAX_BYTES + 1)?.sizeClass).toBe('large-file')
  })

  it('classifies a 250 MB file from stat alone', () => {
    // #given the paste case from the report
    const result = classifyMarkdownStat(250 * 1024 * 1024)

    // #then
    expect(result?.sizeClass).toBe('large-file')
    expect(result?.reason).toBe('file-bytes')
    expect(result?.largestBlockBytes).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// classifyMarkdownContent — both bounds
// ---------------------------------------------------------------------------

describe('classifyMarkdownContent', () => {
  const cases: Array<[name: string, markdown: string, sizeClass: string, reason: string | null]> = [
    ['empty file is a note', '', 'note', null],
    ['short note', 'hello\n\nworld', 'note', null],
    ['at both bounds is a note', 'a'.repeat(20), 'note', null],
    ['over the block bound', 'a'.repeat(21), 'large-file', 'block-bytes'],
    [
      'over the file bound but every block small',
      Array.from({ length: 40 }, () => 'aaa').join('\n\n'),
      'large-file',
      'file-bytes'
    ],
    [
      'under the file bound but one fat block',
      'ok\n\n' + 'x'.repeat(25),
      'large-file',
      'block-bytes'
    ],
    [
      'many small blocks stay a note',
      Array.from({ length: 10 }, () => 'ab').join('\n\n'),
      'note',
      null
    ]
  ]

  it.each(cases)('%s', (_name, markdown, sizeClass, reason) => {
    const result = classifyMarkdownContent(markdown, TINY)
    expect(result.sizeClass).toBe(sizeClass)
    expect(result.reason).toBe(reason)
  })

  it('reports the file bound first when both bounds are breached', () => {
    // #given a file that is both too big and one giant block
    const markdown = 'a'.repeat(200)

    // #when
    const result = classifyMarkdownContent(markdown, TINY)

    // #then — file-bytes is the cheaper, more fundamental reason
    expect(result).toEqual({
      sizeClass: 'large-file',
      reason: 'file-bytes',
      fileBytes: 200,
      largestBlockBytes: 200
    })
  })

  it('always reports measured sizes, including for note class', () => {
    // #when
    const result = classifyMarkdownContent('ab\n\ncdef', TINY)

    // #then — callers log these, so they must be populated on the happy path too
    expect(result).toEqual({
      sizeClass: 'note',
      reason: null,
      fileBytes: 8,
      largestBlockBytes: 4
    })
  })

  it('keeps a well-formed note just under the ceiling in note class', () => {
    // #given ~800 KB of ordinary paragraphs — the shape that measured 450 ms/MB
    const paragraph = 'x'.repeat(4000)
    const markdown = Array.from({ length: 200 }, () => paragraph).join('\n\n')
    expect(utf8ByteLength(markdown)).toBeGreaterThan(0.7 * 1024 * 1024)
    expect(utf8ByteLength(markdown)).toBeLessThan(NOTE_MAX_BYTES)

    // #when / #then — well inside the 1 s budget, so it stays editable
    expect(classifyMarkdownContent(markdown).sizeClass).toBe('note')
  })

  it('rejects a sub-ceiling log dump with no blank lines', () => {
    // #given 900 KB of log lines: under the byte ceiling, one giant block
    const dump = Array.from({ length: 20_000 }, (_, i) => `2026-08-15 line ${i} payload`).join('\n')
    expect(utf8ByteLength(dump)).toBeLessThan(NOTE_MAX_BYTES)

    // #when / #then — this is the case a byte ceiling alone would wrongly accept
    expect(classifyMarkdownContent(dump)).toMatchObject({
      sizeClass: 'large-file',
      reason: 'block-bytes'
    })
  })

  // The #1463 corpus turned up three more whole-document-is-one-block shapes.
  // All three are under the byte ceiling and all three are caught by the block
  // bound, which is the pairing working as intended.
  const oneBlockShapes: Array<[name: string, markdown: string]> = [
    [
      // packages/importers/src/roam joins every bullet with a single newline,
      // so an exported page carries no blank line at all.
      'whole-page outline export (roam/bear)',
      Array.from({ length: 6000 }, (_, i) => `  - bullet ${i} with a little text`).join('\n')
    ],
    [
      'wide markdown table',
      ['| id | value | note |', '| --- | --- | --- |']
        .concat(Array.from({ length: 6000 }, (_, i) => `| ${i} | value ${i} | note ${i} |`))
        .join('\n')
    ],
    [
      'minified json pasted as one line',
      `[${Array.from({ length: 8000 }, (_, i) => `{"id":${i},"ok":true}`).join(',')}]`
    ]
  ]

  it.each(oneBlockShapes)('%s is large-file class on the block bound', (_name, markdown) => {
    // #given a file comfortably under the byte ceiling
    expect(utf8ByteLength(markdown)).toBeLessThan(NOTE_MAX_BYTES)
    expect(utf8ByteLength(markdown)).toBeGreaterThan(NOTE_MAX_BLOCK_BYTES)

    // #when / #then — no blank line anywhere, so the file is a single block.
    // For the table and the JSON that is also the right verdict on cost (a
    // 128 KB block of either measured ~1 s on its own). For the outline it is
    // the bound being deliberately conservative: a list is cheaper per byte
    // than a paragraph, and a byte scan cannot tell the two apart.
    expect(classifyMarkdownContent(markdown)).toMatchObject({
      sizeClass: 'large-file',
      reason: 'block-bytes'
    })
  })
})

// ---------------------------------------------------------------------------
// Shipped thresholds
// ---------------------------------------------------------------------------

describe('shipped thresholds', () => {
  it('are the calibrated values', () => {
    // Changing these is a product decision, not an implementation detail. Both
    // follow from a 1 s parse budget; the corpus, the method and the measured
    // numbers are in
    // docs/superpowers/specs/2026-08-15-note-class-threshold-calibration.md.
    expect(NOTE_MAX_BYTES).toBe(1_048_576)
    expect(NOTE_MAX_BLOCK_BYTES).toBe(131_072)
  })
})
