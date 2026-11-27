/**
 * Backslash escapes for the text BlockNote's markdown writer copies as it is.
 *
 * BlockNote 0.51+ writes a text run's characters unescaped, so text that only
 * looks like markup became markup on the next read: `a \*x\* b` parsed to the
 * text `a *x* b`, was written `a *x* b`, and came back italic. In a table, two
 * stray backticks in different cells paired into one code span and merged the
 * cells. A character is escaped only where the parser (`markdownToHtml.ts` in
 * `@blocknote/core`) could read it as markup, judged on the block as the writer
 * spells it, so text that holds none keeps its bytes. Inside a wiki link that
 * matters: a backslash there would change the link's target for every other
 * reader of the file.
 *
 * A line break in a table cell or a heading is written `<br>`, which the
 * parser reads back as the same break; the backslash form ended the row or the
 * heading. So is a break the writer has no other spelling for: one at a
 * block's edge, which it trims, and one in a run of three or more, which it
 * writes as blank lines that end the paragraph.
 *
 * `<`, `$`, `%` and `=` have no backslash escape in the parser, so text that
 * spells an HTML tag, math, an Obsidian comment or a setext underline is
 * written as it is.
 */

import { spellsCalloutMarker } from '../blocks/markdown'
import { spellsRunsWithUnderscores } from './emphasis-runs'
import { codeSpanRanges } from './link-code-spans'

type Item = {
  type: string
  text?: string
  styles?: Record<string, unknown>
  content?: unknown
  href?: string
}

/** The characters the parser's `tryBackslashEscape` accepts after a backslash. */
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>'

/** Blocks whose text is literal: nothing in them is markup. */
const LITERAL_BLOCKS = new Set(['codeBlock', 'diagram'])

/** Blocks whose lines open blocks of their own: `#`, `>`, `-`, `1.` at a line start. */
const LINE_BLOCKS = new Set([
  'paragraph',
  'quote',
  'callout',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'toggleListItem'
])

/** Stands in for a node the writer spells with none of the characters below. */
const NODE = '\uFFFC'

// `tryParseTable`'s delimiter-row test (`markdownToHtml.ts`).
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

interface Segment {
  /** Where the text starts in the block's spelling. */
  at: number
  text: string
  inLink: boolean
}

const isLink = (item: Item): item is Item & { content: Item[] } =>
  item.type === 'link' && Array.isArray(item.content)

interface Spelling {
  spelling: string
  segments: Segment[]
  /** The offsets of the marks' delimiters, which the writer moves past an edge break. */
  delimiters: Set<number>
  /** The closing ones, which the writer moves before a break that ends their run. */
  closers: Set<number>
}

/** The block as the writer spells it, near enough to tell markup, and its text runs. */
function spell(items: Item[]): Spelling {
  let spelling = ''
  const segments: Segment[] = []
  const delimiters = new Set<number>()
  const closers = new Set<number>()
  const delimit = (delimiter: string, closing: boolean): void => {
    for (let i = 0; i < delimiter.length; i++) {
      delimiters.add(spelling.length + i)
      if (closing) closers.add(spelling.length + i)
    }
    spelling += delimiter
  }
  const walk = (list: Item[], inLink: boolean): void => {
    for (const item of list) {
      if (item.type === 'text' && typeof item.text === 'string') {
        const styles = item.styles ?? {}
        if (styles.code === true) {
          // A break at a code run's edge is written outside its backticks.
          const [, before, after] = /^(\n*)[\s\S]*?(\n*)$/.exec(item.text) ?? ['', '', '']
          spelling += `${before}\`${NODE}\`${after}`
          continue
        }
        const bold = styles.bold === true ? '**' : ''
        const italic = styles.italic === true ? '*' : ''
        const strike = styles.strike === true ? '~~' : ''
        delimit(bold + italic + strike, false)
        segments.push({ at: spelling.length, text: item.text, inLink })
        spelling += item.text
        delimit(strike + italic + bold, true)
      } else if (isLink(item)) {
        spelling += '['
        walk(item.content, true)
        spelling += `](${item.href ?? ''})`
      } else {
        spelling += NODE
      }
    }
  }
  walk(items, false)
  return { spelling, segments, delimiters, closers }
}

const isSpace = (c: string | undefined): boolean => c === undefined || c === ' ' || c === '\t'
const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c)

/** `parseDelimited`: whether the `*` or `_` at `at` could open, and could close, a span. */
function flanks(spelling: string, at: number): { open: boolean; close: boolean } {
  const prev = spelling[at - 1]
  const next = spelling[at + 1]
  const intraword = spelling[at] === '_' && isWord(prev) && isWord(next)
  return { open: !isSpace(next) && !intraword, close: at > 0 && !isSpace(prev) }
}

/** Whether a `*` or `_` at `at` has a partner it could pair with. */
function pairs(spelling: string, at: number): boolean {
  const own = flanks(spelling, at)
  for (let i = 0; i < spelling.length; i++) {
    if (i === at || spelling[i] !== spelling[at]) continue
    const other = flanks(spelling, i)
    if ((own.open && other.close && i > at) || (own.close && other.open && i < at)) return true
  }
  return false
}

/**
 * The offset in `line` of a character that opens a block at a line start, or
 * -1: the block starts `tokenize` (`markdownToHtml.ts`) reads, and on a line
 * after the first, the table row it ends a paragraph at.
 */
function blockOpener(line: string, continuation: boolean): number {
  if (/^(#{1,6}(\s|$)|-+[ \t]*$)/.test(line)) return 0
  if (/^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) return line.search(/\S/)
  if (/^\s{0,3}>|^\s*[-+*](\s|$)/.test(line)) return line.search(/\S/)
  if (/^\[[^\]]*\]:/.test(line)) return 0
  if (line.includes('|') && DELIMITER_ROW.test(line)) return line.indexOf('|')
  if (continuation && /^\s*\|(.+\|)+\s*$/.test(line)) return line.indexOf('|')
  const ordered = /^\s*\d+[.)](\s|$)/.exec(line)
  return ordered ? ordered[0].search(/[.)]/) : -1
}

interface Place {
  lineBlock: boolean
  /** A table cell or a heading: one line, so a break is written `<br>`. */
  oneLine: boolean
  cell: boolean
  paragraph: boolean
}

/** Whether the character at `at` of `spelling` would be read as markup. */
function isMarkup(spelling: string, at: number, segment: Segment, place: Place): boolean {
  const next = spelling[at + 1]
  switch (spelling[at]) {
    case '\\':
      // The writer reads a backslash before a newline, or one ending the
      // block, as a break.
      return next === undefined || next === '\n' || ESCAPABLE.includes(next)
    case '`':
      return place.cell || spelling.indexOf('`') !== at || spelling.lastIndexOf('`') !== at
    case '*':
    case '_':
      return pairs(spelling, at)
    case '~':
      return spelling[at - 1] === '~' || next === '~'
    case '[':
      return segment.inLink
    case ']':
      return segment.inLink || (next === '(' && spelling.lastIndexOf('[', at) >= 0)
    case '!':
      return next === '['
    default:
      return false
  }
}

/**
 * The offsets in `spelling` of the characters that open a block at a line
 * start, past the closers of a run that ended in the break before it.
 */
function lineOpeners({ spelling, closers }: Spelling, place: Place): Set<number> {
  const out = new Set<number>()
  if (!place.lineBlock) return out
  for (let start = 0; ;) {
    const end = spelling.indexOf('\n', start)
    let from = start
    while (closers.has(from)) from++
    const opener = blockOpener(spelling.slice(from, end < 0 ? undefined : end), start > 0)
    if (opener >= 0) out.add(from + opener)
    if (end < 0) return out
    start = end + 1
  }
}

/**
 * The offsets of each `[[` with no `]]` after it, in a table cell. The reader
 * escapes the pipes between a `[[` and the next `]]` in a row
 * (`escapeWikiLinkPipesInTableRows`), so an unclosed one would join its cell
 * to the cells up to a `]]`.
 */
function unclosedWikiOpeners(spelling: string): Set<number> {
  const out = new Set<number>()
  for (let at = spelling.indexOf('[['); at !== -1; at = spelling.indexOf('[[', at + 2)) {
    if (!spelling.includes(']]', at + 2)) out.add(at).add(at + 1)
  }
  return out
}

/**
 * Whether the newline at `at` sits where the writer has no spelling for it: at
 * the block's start or end, or in a run of three or more. A lone one opening a
 * paragraph with more after it is left to the writer, which drops it: a `<br>`
 * opening a paragraph line reads back as a hard break (`maskHardBreaks`). A
 * paragraph of one break is `<br>` alone. A mark's delimiters do not count,
 * since the writer moves them past the break.
 */
function unwritableBreak(block: Spelling, at: number, paragraph: boolean): boolean {
  const { spelling, delimiters } = block
  const passes = (i: number): boolean => spelling[i] === '\n' || delimiters.has(i)
  let start = at
  while (start > 0 && passes(start - 1)) start--
  let end = at + 1
  while (end < spelling.length && passes(end)) end++
  const run = spelling.slice(start, end).split('\n').length - 1
  if (start === 0) return !paragraph || run > 1 || end === spelling.length
  return end === spelling.length || run >= 3
}

function escapeSegment(
  block: Spelling,
  segment: Segment,
  place: Place,
  forced: Set<number>
): string {
  const { spelling } = block
  const keep = new Set<number>()
  if (segment.inLink) {
    for (const [at, length] of codeSpanRanges(segment.text)) {
      for (let i = at; i < at + length; i++) keep.add(segment.at + i)
    }
  }
  let out = ''
  for (let i = 0; i < segment.text.length; i++) {
    const at = segment.at + i
    const char = segment.text[i]
    const tag =
      char === '\n' &&
      (place.oneLine || (place.lineBlock && unwritableBreak(block, at, place.paragraph)))
    if (tag) out += '<br>'
    else if (!keep.has(at) && (forced.has(at) || isMarkup(spelling, at, segment, place))) {
      out += `\\${char}`
    } else out += char
  }
  return out
}

/** `items` of a block of type `blockType` (none for a table cell), escaped for the markdown writer. */
export function escapeMarkdownText<T extends Item>(items: T[], blockType?: string): T[] {
  if (blockType !== undefined && LITERAL_BLOCKS.has(blockType)) return items
  const cell = blockType === undefined
  const place: Place = {
    lineBlock: !cell && LINE_BLOCKS.has(blockType),
    oneLine: cell || blockType === 'heading',
    cell,
    paragraph: blockType === 'paragraph'
  }
  const block = spell(items)
  const { spelling, segments } = block
  const forced = lineOpeners(block, place)
  const firstLine = spelling.split('\n', 1)[0]
  if (spellsCalloutMarker(blockType ?? '', firstLine, firstLine === spelling)) forced.add(0)
  if (cell) for (const at of unclosedWikiOpeners(spelling)) forced.add(at)
  const escape = (): T[] =>
    escapeItems(
      items,
      segments.map((segment) => escapeSegment(block, segment, place, forced))
    )
  const escaped = escape()
  // An underscore delimiter pairs with any bare `_` in its block.
  if (!spellsRunsWithUnderscores(escaped)) return escaped
  for (const { at, text } of segments) {
    for (let i = text.indexOf('_'); i !== -1; i = text.indexOf('_', i + 1)) forced.add(at + i)
  }
  return escape()
}

/** `items` with each text run's text replaced by the next of `escaped`. */
function escapeItems<T extends Item>(items: T[], escaped: string[]): T[] {
  let next = 0
  const rewrite = (list: Item[]): Item[] =>
    list.map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') {
        if (item.styles?.code !== true) return { ...item, text: escaped[next++] }
        // The parser strips one space off each end of a code span that has
        // one at both, so ` b ` is written with a second.
        const spaced = /^ [\s\S]* $/.test(item.text) && /[^ ]/.test(item.text)
        return spaced ? { ...item, text: ` ${item.text} ` } : item
      }
      if (isLink(item)) return { ...item, content: rewrite(item.content) }
      return item
    })
  // SAFETY: only `text` and `content` are replaced, with values of the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
  return rewrite(items) as T[]
}
