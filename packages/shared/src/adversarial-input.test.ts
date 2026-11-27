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
  ['a delimiter row under a table row', () => maskHardBreaks(`| a |\n|-${'\t'.repeat(50_000)}x`)],
  // Each `>` could take the space after it or leave it to the next marker.
  [
    'quote and list markers before no comment',
    () => stripMarkdownComments(`<!-- c -->\n>${' -  >'.repeat(24)}\0`)
  ],
  // Each marker reads every marker line below it before it finds no link.
  [
    'a run of link-card markers before no link',
    () => maskHtmlComments(`${'<!-- link-card:{} -->\n'.repeat(5000)}\0`)
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

describe('adversarial markdown input', () => {
  it.each(cases)('%s runs in linear time', (_name, run) => {
    const start = performance.now()
    run()
    expect(performance.now() - start).toBeLessThan(LIMIT_MS)
  })
})
