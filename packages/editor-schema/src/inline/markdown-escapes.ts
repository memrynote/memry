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
 * written as it is. A tag the editor does not handle, spelled whole on one line,
 * is read back as the characters it holds (`maskRawHtml`), so nothing inside
 * it is escaped, and nothing inside it pairs with a mark outside: `<x a="*">`
 * would gain a backslash each time the note is written and read. A tag the
 * editor does handle, spelled in text, is written with its `<` escaped
 * (`\<b>x\</b>`), which the reader takes as the text, so it is not read as a mark.
 */

import { TABLE_DELIMITER, TABLE_ROW } from '../blocks/block-starts'
import { spellsCalloutMarker } from '../blocks/markdown'
import { spellsRunsWithUnderscores } from './emphasis-runs'
import { codeSpanRanges } from './link-code-spans'
import { spelledTags } from './raw-html'

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
  /**
   * The closing ones, and each link's `](href)`, which the writer moves before
   * a break that ends their run.
   */
  closers: Set<number>
  /** The offsets inside a tag spelled whole, which are written as they are. */
  verbatim: Set<number>
  /** The offsets of the `<` of a tag the editor handles, which is written `\\<`. */
  tagStarts: Set<number>
}

/** The block as the writer spells it, near enough to tell markup, and its text runs. */
function spell(items: Item[]): Spelling {
  let spelling = ''
  const segments: Segment[] = []
  const delimiters = new Set<number>()
  const closers = new Set<number>()
  const verbatim = new Set<number>()
  const tagStarts = new Set<number>()
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
          spelling += `\`${NODE}\``
          continue
        }
        const bold = styles.bold === true ? '**' : ''
        const italic = styles.italic === true ? '*' : ''
        const strike = styles.strike === true ? '~~' : ''
        delimit(bold + italic + strike, false)
        segments.push({ at: spelling.length, text: item.text, inLink })
        // A tag is no markup to the characters around it: it stands as nodes do.
        let last = 0
        for (const { start, end, escaped } of spelledTags(item.text)) {
          spelling += item.text.slice(last, start) + NODE.repeat(end - start)
          for (let i = start; i < end; i++) verbatim.add(spelling.length - (end - i))
          if (escaped) tagStarts.add(spelling.length - (end - start))
          last = end
        }
        spelling += item.text.slice(last)
        delimit(strike + italic + bold, true)
      } else if (isLink(item)) {
        spelling += '['
        walk(item.content, true)
        const close = `](${item.href ?? ''})`
        for (let i = 0; i < close.length; i++) closers.add(spelling.length + i)
        spelling += close
      } else {
        spelling += NODE
      }
    }
  }
  walk(items, false)
  return { spelling, segments, delimiters, closers, verbatim, tagStarts }
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
  if (line.includes('|') && TABLE_DELIMITER.test(line)) return line.indexOf('|')
  if (continuation && TABLE_ROW.test(line)) return line.indexOf('|')
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

/** Whether the character at `at` of the block's spelling would be read as markup. */
function isMarkup(block: Spelling, at: number, segment: Segment, place: Place): boolean {
  const { spelling, delimiters } = block
  const next = spelling[at + 1]
  switch (spelling[at]) {
    case '\\':
      // The writer reads a backslash before a newline, or one ending the
      // block, as a break; the reader, one before an escaped tag as its escape.
      return (
        next === undefined ||
        next === '\n' ||
        ESCAPABLE.includes(next) ||
        block.tagStarts.has(at + 1)
      )
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
    case '!': {
      // A run that continues into a link is written around it (`**c ![x](y)**`).
      let after = at + 1
      while (delimiters.has(after)) after++
      return spelling[after] === '['
    }
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
    else if (block.tagStarts.has(at)) out += `\\${char}`
    else if (block.verbatim.has(at)) out += char
    else if (!keep.has(at) && (forced.has(at) || isMarkup(block, at, segment, place))) {
      out += `\\${char}`
    } else out += char
  }
  return out
}

const sameStyles = (a: Item, b: Item): boolean => {
  const left = Object.entries(a.styles ?? {})
  const right = b.styles ?? {}
  return (
    left.length === Object.keys(right).length && left.every(([key, value]) => right[key] === value)
  )
}

/**
 * The runs of `group`, side by side, with the marks taken off the characters of
 * each tag that a boundary between two of them cuts through. The reader hides a
 * whole tag and keeps what is inside it as text, so the delimiters the writer
 * would put inside one (`<x a="**\***">`) became characters of the tag. What
 * is outside the tag keeps its marks, and the pieces left side by side with the
 * same marks are one run again, so each tag is whole in a run.
 */
function unmarkGroup<T extends Item>(group: T[]): T[] {
  const starts: number[] = []
  let plain = ''
  for (const item of group) {
    starts.push(plain.length)
    plain += item.text ?? ''
  }
  if (!plain.includes('<')) return group
  // The run each character of `plain` is in.
  const owner = new Uint32Array(plain.length)
  starts.forEach((start, index) => owner.fill(index, start, starts[index + 1] ?? plain.length))
  const cut = spelledTags(plain).filter(
    ({ start, end }) => end - start > 1 && owner[start] !== owner[end - 1]
  )
  if (cut.length === 0) return group
  const stripped = new Uint8Array(plain.length)
  for (const { start, end } of cut) stripped.fill(1, start, end)
  const out: T[] = []
  group.forEach((item, index) => {
    const text = item.text ?? ''
    for (let from = 0; from < text.length;) {
      const unmarked = stripped[starts[index] + from] === 1
      let to = from + 1
      while (to < text.length && (stripped[starts[index] + to] === 1) === unmarked) to++
      const piece = { ...item, text: text.slice(from, to), ...(unmarked ? { styles: {} } : {}) }
      const last = out.at(-1)
      if (last && sameStyles(last, piece))
        out[out.length - 1] = { ...last, text: (last.text ?? '') + piece.text }
      else out.push(piece)
      from = to
    }
  })
  return out
}

/**
 * `items` with the marks off the characters of each tag a mark boundary cuts
 * through, in runs of text side by side (`unmarkGroup`). A link, a node or an
 * empty run ends a group.
 */
function unmarkCutTags<T extends Item>(items: T[]): T[] {
  const out: T[] = []
  let group: T[] = []
  const flush = (): void => {
    out.push(...unmarkGroup(group))
    group = []
  }
  for (const item of items) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text !== '') {
      group.push(item)
      continue
    }
    flush()
    out.push(isLink(item) ? { ...item, content: unmarkCutTags(item.content) } : item)
  }
  flush()
  return out
}

/** `items` of a block of type `blockType` (none for a table cell), escaped for the markdown writer. */
export function escapeMarkdownText<T extends Item>(list: T[], blockType?: string): T[] {
  if (blockType !== undefined && LITERAL_BLOCKS.has(blockType)) return list
  const items = unmarkCutTags(codeBreaksApart(list))
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
    for (let i = text.indexOf('_'); i !== -1; i = text.indexOf('_', i + 1)) {
      if (!block.verbatim.has(at + i)) forced.add(at + i)
    }
  }
  return escape()
}

/**
 * The parser strips one space off each end of a code span that has one at
 * both, so ` b ` is written with a second. A break splits a code run into one
 * span per line.
 */
function spacedCodeLine(line: string): string {
  return /^ [\s\S]* $/.test(line) && /[^ ]/.test(line) ? ` ${line} ` : line
}

/**
 * `items` with each code run's breaks taken out into text runs of their own.
 * The writer spells them outside the backticks, where they are breaks like any
 * other: three after `` `a` `` were written as blank lines that split the
 * paragraph, with no `<br>` for them.
 */
function codeBreaksApart<T extends Item>(items: T[]): T[] {
  return items.flatMap((item) => {
    if (item.type !== 'text' || item.styles?.code !== true || !item.text?.includes('\n')) {
      return [item]
    }
    const { code: _code, ...styles } = item.styles
    return item.text
      .split(/(\n+)/)
      .filter((part) => part !== '')
      .map((text) => (text.startsWith('\n') ? { ...item, text, styles } : { ...item, text }))
  })
}

/** `items` with each text run's text replaced by the next of `escaped`. */
function escapeItems<T extends Item>(items: T[], escaped: string[]): T[] {
  let next = 0
  const rewrite = (list: Item[]): Item[] =>
    list.map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') {
        if (item.styles?.code !== true) return { ...item, text: escaped[next++] }
        return { ...item, text: item.text.split('\n').map(spacedCodeLine).join('\n') }
      }
      if (isLink(item)) return { ...item, content: rewrite(item.content) }
      return item
    })
  // SAFETY: only `text` and `content` are replaced, with values of the same shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
  return rewrite(items) as T[]
}
