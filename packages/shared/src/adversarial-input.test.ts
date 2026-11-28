import { describe, expect, it } from 'vitest'
import { splitMarkdownPreservingBlanks } from './empty-lines'
import { maskHardBreaks, unmaskHardBreaks } from './hard-breaks'
import { maskHtmlComments } from './html-comments'
import { maskInlineColorSpans } from './inline-colors'
import { stripMarkdownComments } from './markdown-code'

/**
 * Pasted or synced markdown is user input, and these masks run on the
 * renderer's thread. Each input below made a backtracking regex take seconds;
 * every mask must stay linear in its input.
 */
const LIMIT_MS = 100

// The token `maskHardBreaks` leaves for a line ending in two spaces, to put in front of a run of blanks.
const hardBreakToken = maskHardBreaks('a  \nb').markdown.split('\n')[0].slice(1)

const cases: Array<[string, () => unknown]> = [
  // Each shorter split of the run is compared against the rest of it, then fails at the text.
  [
    'a long run of backticks beside a color span',
    () => maskInlineColorSpans(`x ${'`'.repeat(150_000)}${'a'.repeat(150_000)}</span>`)
  ],
  // Each `<span` reads on to the end of the line for a `>` that never comes.
  [
    'a line of unfinished span tags',
    () => maskInlineColorSpans(`${'<span '.repeat(50_000)}</span>`)
  ],
  [
    'a line of unfinished coloured span tags',
    () => maskInlineColorSpans(`${'<span style="'.repeat(30_000)}</span>`)
  ],
  ['a delimiter row under a table row', () => maskHardBreaks(`| a |\n|-${'\t'.repeat(50_000)}x`)],
  // Each `>` could take the space after it or leave it to the next marker.
  [
    'quote and list markers before no comment',
    () => stripMarkdownComments(`<!-- c -->\n>${' -  >'.repeat(24)}\0`)
  ],
  // Each `*` could be one `**` token or two `*` tokens.
  [
    'a link-card marker before a run of stars',
    () => maskHtmlComments(`<!-- link-card:{} -->\n${'*'.repeat(40)}x`)
  ],
  [
    'a link-card marker before a link that closes in a run of stars',
    () => maskHtmlComments(`<!-- link-card:{} -->\n[[a]]${'*'.repeat(34)}x`)
  ],
  // Every start in the run of newlines reads the rest of the run, then fails at the text.
  [
    'a fenced block holding a long run of blank lines',
    () => splitMarkdownPreservingBlanks(`\`\`\`\n${'\n'.repeat(20_000)}x\n\`\`\``)
  ],
  // Each start in the run of tabs reads the rest of it, then fails at the text.
  ['a line of tabs before a character', () => maskHardBreaks(`a\n${'\t'.repeat(20_000)}x\nb`)],
  [
    'a run of blanks before a token',
    () => unmaskHardBreaks(`${'\t'.repeat(20_000)}x ${hardBreakToken}`)
  ]
]

// A list item's link text or hard breaks over many lines join into one line, and each join read the rest
// of the paragraph again. These time how the cost grows rather than one size against the limit: 16 times
// the lines cost about 16 times as much read once each, and 256 times read again for each line. The short
// and long inputs are timed in turn and each keeps its fastest of seven runs, so a loaded runner slows both
// alike.
const longListItems: Array<[string, (count: number) => string, number]> = [
  ['link text over many lines', (count) => `- [a\n${'b\n'.repeat(count)}](u)`, 500],
  ['hard breaks on many lines', (count) => `- a  \n${'b  \n'.repeat(count)}`, 500],
  [
    'many lines before a link they do not open',
    (count) => `- a\n${'b\n'.repeat(count)}x](u) y`,
    500
  ],
  [
    'link text before nested addresses',
    (count) => `- [x\n${'](a'.repeat(count)}${')'.repeat(count + 1)}`,
    500
  ]
]

const elapsed = (run: () => unknown): number => {
  const start = performance.now()
  run()
  return performance.now() - start
}

const growth = (read: (text: string) => unknown, short: string, long: string): number => {
  let shortMs = Infinity
  let longMs = Infinity
  for (let run = 0; run < 7; run++) {
    shortMs = Math.min(
      shortMs,
      elapsed(() => read(short))
    )
    longMs = Math.min(
      longMs,
      elapsed(() => read(long))
    )
  }
  return longMs / shortMs
}

describe('adversarial markdown input', () => {
  it.each(cases)('%s runs in linear time', (_name, run) => {
    expect(elapsed(run)).toBeLessThan(LIMIT_MS)
  })

  it.each(longListItems)('a list item of %s is masked in linear time', (_name, item, count) => {
    expect(growth(maskHardBreaks, item(count), item(count * 16))).toBeLessThan(64)
  })

  // Each marker read every marker line below it before it found no link. At 4000 markers a loaded
  // runner took 437 to 642 ms of wall clock for 7 to 17 ms of work, so this times growth as above.
  it('a run of link-card markers before no link is read in linear time', () => {
    const markers = (count: number): string => `${'<!-- link-card:{} -->\n'.repeat(count)}\0`
    expect(growth(maskHtmlComments, markers(250), markers(4000))).toBeLessThan(64)
  })
})
