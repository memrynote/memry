import { markdownToHTML } from '@blocknote/core'
import { describe, expect, it } from 'vitest'
import { endsParagraphBefore, opensBlock } from './blocks/block-starts'
import { escapePrefixedDetailsMarkup } from './blocks/markdown'
import { spellsRunsWithUnderscores, trimEmphasisEdges } from './inline/emphasis-runs'
import { maskCellCodeSpans } from './inline/cell-code-spans'
import { maskCodeAcrossLines } from './inline/code-mask'
import { maskEmptyLinks } from './inline/empty-links'
import { maskLinkDestinations } from './inline/link-destinations'
import { escapeMarkdownText } from './inline/markdown-escapes'
import { escapeUnwritableLinks } from './inline/unwritable-links'
import { liftImagesOutOfTextBlocks } from './lift-images'
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

// BlockNote's own markdown parser reads lines the readers above never see, and every line below made
// one of its patterns take seconds. The line is cut to the size that fails on 0.54.2 in about a second.
const cubicLine = (count: number): string => `#${'\t'.repeat(count)}x${'\t'.repeat(count)}\ry`

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
  // Each tag a mark boundary cuts is found once, and each run is split once.
  [
    'many runs, each cutting a tag',
    () =>
      escapeMarkdownText(
        Array.from({ length: 20_000 }, (_, index) => ({
          type: 'text',
          text: index % 2 === 0 ? '<x a="' : '">',
          styles: index % 4 === 0 ? { bold: true } : {}
        })),
        'paragraph'
      )
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
    'a line of links whose address leaves a parenthesis open',
    () => escapeUnwritableLinks('[a](x(y\nz) '.repeat(20_000))
  ],
  [
    'a line of links no parenthesis closes',
    () => escapeUnwritableLinks('[a](x(y z '.repeat(30_000))
  ],
  [
    'lines of backtick runs of every length, none closing another',
    () => maskCodeAcrossLines(Array.from({ length: 1500 }, (_, i) => '`'.repeat(i + 1)).join('\n'))
  ],
  ['lines of single backticks in one paragraph', () => maskCodeAcrossLines('a`\n'.repeat(20_000))],
  // Every tick of a line is a candidate opener, and a line holds no more than one pass of work.
  ['one line of single backticks', () => maskCodeAcrossLines('a`'.repeat(100_000))],
  // No run of 2 to 601 backticks has a closer of its length, so each retries against the shorter
  // runs that follow it on the line: the first of each length, found once for the whole line.
  [
    'one line of backtick runs no run closes, then many single backticks',
    () =>
      maskCodeAcrossLines(
        `${Array.from({ length: 600 }, (_, i) => `${'`'.repeat(601 - i)}x `).join('')}${'a ` '.repeat(25_000)}`
      )
  ],
  [
    'a line of empty-label links in nested parens',
    () => maskEmptyLinks(`${'[](('.repeat(25_000)}${'))'.repeat(25_000)}`)
  ],
  // `<!--` with no `-->` reads to the end from every opener.
  [
    'an image lift over many unclosed comments',
    () => liftImagesOutOfTextBlocks(`${'<!--'.repeat(30_000)}<p>x</p>`, false)
  ],
  [
    'an image lift over many unclosed tags',
    () => liftImagesOutOfTextBlocks(`<p>x</p>${'<a'.repeat(30_000)}`, false)
  ],
  // Each blank of the run starts a match that reads the rest of it, then fails at the text.
  [
    'an image after a long run of blanks',
    () => liftImagesOutOfTextBlocks(`<p>x${' '.repeat(20_000)}y<img src="a"></p>`, false)
  ],
  // Each `<a` reads to the one `>` that ends the comment, then finds no image.
  [
    'an image after many links that hold no image',
    () => liftImagesOutOfTextBlocks(`<p>x<!--${'<a '.repeat(10_000)}-->y<img src="a"></p>`, false)
  ],
  [
    'an image before many stray openers',
    () => liftImagesOutOfTextBlocks(`<p><img src="a">${'<'.repeat(20_000)}</p>`, false)
  ],
  ['BlockNote reads a heading line of tabs', () => markdownToHTML(cubicLine(600))],
  [
    'BlockNote reads a hard break after a run of spaces',
    () => markdownToHTML(`a${' '.repeat(20_000)}x  \nb`)
  ],
  ['BlockNote reads a fence line of tildes', () => markdownToHTML(`${'~'.repeat(20_000)}\r`)],
  ['BlockNote reads a list marker before tabs', () => markdownToHTML(`*${'\t'.repeat(20_000)}x\r`)],
  [
    'BlockNote reads a list item with a run of blank lines',
    () => markdownToHTML(`- a\n  b\n${'\n'.repeat(20_000)}  c`)
  ],
  ['BlockNote reads a paragraph ending in tabs', () => markdownToHTML(`a${'\t'.repeat(20_000)}x`)],
  ['BlockNote reads a delimiter row', () => markdownToHTML(`| a |\n${delimiter(20_000)}`)],
  ['BlockNote reads a table row after a paragraph', () => markdownToHTML(`a\n${pipes(22)}`)],
  ['BlockNote reads a table row after a quote', () => markdownToHTML(`> a\n${pipes(22)}`)],
  // A closer search that fails reads to the end for every opener after it.
  ['BlockNote reads a run of unclosed italics', () => markdownToHTML('*a '.repeat(5000))],
  ['BlockNote reads a run of unclosed bold', () => markdownToHTML('**a '.repeat(5000))],
  ['BlockNote reads a run of unclosed underscores', () => markdownToHTML('_a '.repeat(5000))],
  ['BlockNote reads a run of unclosed strikethrough', () => markdownToHTML('~~a '.repeat(5000))],
  ['BlockNote reads a run of unclosed link texts', () => markdownToHTML('[a'.repeat(8000))],
  ['BlockNote reads a run of unclosed image texts', () => markdownToHTML('![a'.repeat(5000))],
  ['BlockNote reads a run of unclosed link addresses', () => markdownToHTML('[a](b'.repeat(5000))],
  // Each `[` reads to the end for a `(` that never closes.
  ['a line of links no paren closes', () => maskLinkDestinations('[a](b'.repeat(8000))],
  // Each break trims the spaces off everything written so far.
  ['BlockNote reads many hard breaks', () => markdownToHTML(`${'a  \n'.repeat(8000)}b`)]
]

const elapsed = (run: () => unknown): number => {
  const start = performance.now()
  run()
  return performance.now() - start
}

// A comment, CDATA section, instruction or declaration with no end is read to the end of the text from
// every opener. 0.54.2 reads each one cheaply, so a line long enough to fail the limit there costs a fair
// share of it here too. These time how the cost grows instead: 16 times the openers cost about 16 times
// as much read once each, and 256 times read to the end from each. The short and long lines are timed in
// turn and each keeps its fastest of seven runs, so a loaded runner slows both alike.
const unclosedOpeners: Array<[string, (openers: number) => string, number]> = [
  ['comments', (openers) => `a ${'<!--'.repeat(openers)}`, 1250],
  ['CDATA sections', (openers) => `a ${'<![CDATA['.repeat(openers)}`, 250],
  ['instructions', (openers) => `a ${'<?'.repeat(openers)}`, 2500],
  ['declarations', (openers) => `a ${'<!a'.repeat(openers)}`, 1250]
]

const growth = (short: string, long: string): number => {
  let shortMs = Infinity
  let longMs = Infinity
  for (let run = 0; run < 7; run++) {
    shortMs = Math.min(
      shortMs,
      elapsed(() => markdownToHTML(short))
    )
    longMs = Math.min(
      longMs,
      elapsed(() => markdownToHTML(long))
    )
  }
  return longMs / shortMs
}

describe('adversarial markdown input', () => {
  // Each nested link costs the parser a few stack frames. Before its code is optimized, 0.54.2 read links
  // nested 2125 deep and the first linear-time patch only 2000, so this runs before the cases below warm
  // the parser up.
  it('BlockNote reads links nested 2050 deep', () => {
    const depth = 2050
    expect(markdownToHTML(`${'[a '.repeat(depth)}${'](u)'.repeat(depth)}`)).toContain('href="u"')
  })

  it.each(cases)('%s runs in linear time', (_name, run) => {
    expect(elapsed(run)).toBeLessThan(LIMIT_MS)
  })

  it.each(unclosedOpeners)(
    'BlockNote reads many unclosed %s in linear time',
    (_name, line, openers) => {
      expect(growth(line(openers), line(openers * 16))).toBeLessThan(64)
    }
  )

  it('a long table row ends a paragraph in linear time', () => {
    // Before the fix the long row never returned, so the short one fails first.
    expect(elapsed(() => endsParagraphBefore(pipes(24)))).toBeLessThan(LIMIT_MS)
    expect(elapsed(() => endsParagraphBefore(pipes(50_000)))).toBeLessThan(LIMIT_MS)
  })
})
