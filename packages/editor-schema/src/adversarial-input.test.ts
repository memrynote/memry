import { describe, expect, it } from 'vitest'
import { endsParagraphBefore, opensBlock } from './blocks/block-starts'
import { escapePrefixedDetailsMarkup } from './blocks/markdown'
import { spellsRunsWithUnderscores, trimEmphasisEdges } from './inline/emphasis-runs'
import { maskCellCodeSpans } from './inline/cell-code-spans'
import { maskEmptyLinks } from './inline/empty-links'
import { escapeMarkdownText } from './inline/markdown-escapes'
import { widenTables } from './table-width'

/**
 * Pasted or synced markdown is user input, and these readers and writers run
 * on the renderer's thread. Each input below made a backtracking regex take
 * seconds (or forever); every reader must stay linear in its input.
 */
const LIMIT_MS = 100

// Fails a `.+\|` repeated under `+` on every split of the pipes.
const pipes = (count: number): string => `|${'a|'.repeat(count)}x`
// A delimiter row whose trailing whitespace two `\s*` share, then a character that ends the match.
const delimiter = (count: number): string => `|-${'\t'.repeat(count)}x`

const cases: Array<[string, () => unknown]> = [
  ['a delimiter row opens a block', () => opensBlock(['a', delimiter(50_000), 'b'], 2, 0)],
  [
    'the escaper reads a table row opening a line',
    () => escapeMarkdownText([{ type: 'text', text: `a\n${pipes(24)}`, styles: {} }], 'paragraph')
  ],
  [
    'the escaper reads a delimiter row',
    () => escapeMarkdownText([{ type: 'text', text: delimiter(50_000), styles: {} }], 'paragraph')
  ],
  ['table widening reads a delimiter row', () => widenTables(`| a |\n${delimiter(50_000)}\n| b |`)],
  [
    'a bold run edged by a long run of tabs',
    () =>
      spellsRunsWithUnderscores([
        { type: 'text', text: `<${'\t'.repeat(50_000)}>>`, styles: { bold: true } }
      ])
  ],
  [
    'a bold run ending in tabs before a character',
    () =>
      trimEmphasisEdges([
        { type: 'text', text: `a${'\t'.repeat(50_000)}x\t`, styles: { bold: true } }
      ])
  ],
  [
    'a summary line of many closing tags and breaks',
    () => escapePrefixedDetailsMarkup(`<summary>${'</summary><br>'.repeat(10_000)}\u2028`)
  ],
  // Runs of backticks of every length, none closing another: a scan to the end per opener.
  [
    'a line of code spans no run closes',
    () =>
      maskCellCodeSpans(Array.from({ length: 1500 }, (_, i) => `${'`'.repeat(i + 1)} `).join(''), {
        pipes: false
      })
  ],
  [
    'a line of empty-label link openers no paren closes',
    () => maskEmptyLinks('[](a '.repeat(50_000))
  ],
  [
    'a line of empty-label links in nested parens',
    () => maskEmptyLinks(`${'[](('.repeat(25_000)}${'))'.repeat(25_000)}`)
  ]
]

const elapsed = (run: () => unknown): number => {
  const start = performance.now()
  run()
  return performance.now() - start
}

describe('adversarial markdown input', () => {
  it.each(cases)('%s runs in linear time', (_name, run) => {
    expect(elapsed(run)).toBeLessThan(LIMIT_MS)
  })

  it('a long table row ends a paragraph in linear time', () => {
    // Before the fix the long row never returned, so the short one fails first.
    expect(elapsed(() => endsParagraphBefore(pipes(24)))).toBeLessThan(LIMIT_MS)
    expect(elapsed(() => endsParagraphBefore(pipes(50_000)))).toBeLessThan(LIMIT_MS)
  })
})
