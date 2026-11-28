import { createFenceTracker } from '@memry/shared/markdown-fences'
import { MASK_WORD } from '@memry/shared/mask-word'

/**
 * Raw HTML the editor has no node for, kept as the text the author wrote.
 *
 * BlockNote's markdown pass hands a tag through as HTML (`tryInlineHtml`),
 * ProseMirror finds no node or mark for `<kbd>` or `<sup>` and drops the
 * element, keeping its children, and a `<script>` loses its body with it. A
 * block tag at a line start (`isHtmlBlockStart`) also became a raw HTML block
 * that split the paragraph it opened. So a note's `<kbd>Ctrl</kbd>` read back
 * as `Ctrl`, and the characters were gone from the next write.
 *
 * Every `<` that opens a construct the editor does not handle is hidden from
 * the parse and put back as text:
 *
 * - A whole tag, comment-free declaration, CDATA section or processing
 *   instruction that closes on its own line, within `BOUND` characters, is one
 *   token holding all of its characters. What is inside it is not markdown, so
 *   `<x a="*b*">` stays literal, and the text between two tags is read as
 *   markdown text, as CommonMark reads it.
 * - Any other candidate (a tag that closes on a later line, `<div` with no `>`,
 *   an unclosed `<?`, one past the bound, one with a `|` in it, which a table
 *   row splits at) hides only its `<`.
 *
 * The tags the editor does handle are not touched: `b strong i em u s del
 * strike code a img br`, the media, heading, rule, quote, code, list and table
 * tags of `HANDLED_TAGS`, a `<span>` with a `style` and the `</span>` that
 * closes one, `<details data-memry-toggle>` and `<input type=checkbox>`. A
 * `<!--` comment has its own masks. A `<` inside code (a fence, a code span) or
 * at the start of a link's address (`](<x y>)`) is not a tag.
 *
 * The token is `;MEMRYRAW<word><n>;`. Both ends are `;`, which is no word
 * character, no space and nothing the parser reads as syntax (BlockNote's
 * `SPECIAL_CHARS`, a backslash escape, a block start), so emphasis next to or
 * between tags is read as it was with the angle brackets there. The writer spells
 * the tags back as they are (`escapeMarkdownText`), so seed and write settle.
 *
 * A handled tag opened while `MAX_NESTING` handled tags are open is text too, and
 * so is its closing tag. The HTML parse that reads the handled tags recurses
 * once per open one: 4000 unclosed `<b>` took 5 s, 4000 `<ul><li>` 50 s, and
 * 8000 overflowed the stack. No text reaches it deeper than the cap.
 *
 * The core's seed hides the same `<` the same way
 * (`crates/memry-core/src/crdt/markdown_seed/raw_html.rs`); chapter 12 states
 * the rule.
 */

/** The longest tag, in UTF-16 units from its `<`, read as one token. */
export const RAW_HTML_BOUND = 1024

/**
 * How many handled tags may be open at once. The core's seed stops building
 * at the same depth (`MAX_NESTING` in `markdown_seed/nesting.rs`).
 */
export const RAW_HTML_MAX_NESTING = 100

/** The characters `tryBackslashEscape` takes after a backslash. */
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>'

/**
 * The tags the editor turns into a mark, a node or a line break, by name: the
 * inline marks and a link, an image with its caption (`<figure><img>
 * <figcaption>`, how BlockNote writes one), a video or audio, a heading, a
 * rule, a quote, a code block (`<pre><code>`), a list and a table with its
 * rows and cells. A family reads as one, so it is handled whole.
 */
const HANDLED_TAGS: ReadonlySet<string> = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'strike',
  'code',
  'a',
  'img',
  'br',
  'figure',
  'figcaption',
  'video',
  'audio',
  'source',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col'
])

/** The handled tags that hold nothing, so they never nest. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'img', 'hr', 'source', 'col', 'input'])

const PLACEHOLDER_PREFIX = `;MEMRYRAW${MASK_WORD}`
const PLACEHOLDER = new RegExp(`;MEMRYRAW${MASK_WORD}(\\d+);`, 'g')
const placeholder = (index: number): string => `${PLACEHOLDER_PREFIX}${index};`

/** A hidden range of the scanned text: `end - start` is 1 for a lone `<`. */
export interface RawHtmlSpan {
  start: number
  end: number
}

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
const isNameChar = (c: string | undefined): boolean =>
  isLetter(c) || (c !== undefined && ((c >= '0' && c <= '9') || c === '-'))
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t'
const isAttrStart = (c: string | undefined): boolean => isLetter(c) || c === '_' || c === ':'
const isAttrChar = (c: string | undefined): boolean =>
  isNameChar(c) || c === '_' || c === ':' || c === '.'
const isUnquoted = (c: string): boolean => !isBlank(c) && !'"\'=<>`'.includes(c)

interface Tag {
  name: string
  closing: boolean
  selfClosing: boolean
  /** Lowercased names with their values, quotes off. */
  attrs: Array<[string, string]>
}

interface Construct {
  end: number
  tag: Tag | null
}

/**
 * The next place `needle` starts at or after a position that only moves
 * forward, or -1. The last hit stands until the position passes it, and a miss
 * stands for good, so a line of unfinished `<?` costs one search, not one per `<`.
 */
function finder(line: string, needle: string): (from: number) => number {
  let found = -2
  return (from) => {
    if (found === -1 || found >= from) return found
    found = line.indexOf(needle, from)
    return found
  }
}

interface Closers {
  cdata: (from: number) => number
  instruction: (from: number) => number
  declaration: (from: number) => number
}

/** Where `needle` starts at or after `from`, and ends by `limit`, or -1. */
function indexBefore(line: string, needle: string, from: number, limit: number): number {
  for (let at = from; at + needle.length <= limit; at++) {
    if (line.startsWith(needle, at)) return at
  }
  return -1
}

/**
 * A tag as `INLINE_HTML_TAG_RE` reads one, with only space and tab as
 * whitespace and every search stopped at `limit`: a name, attributes that each
 * follow a blank, a value that is quoted or has none of `\s"'=<>\``, and
 * `/?>`. No step can be taken back, so the read is linear.
 */
function readTag(line: string, at: number, limit: number): Construct | null {
  let p = at + 1
  const closing = line[p] === '/'
  if (closing) p++
  if (!isLetter(line[p])) return null
  const nameStart = p
  while (p < limit && isNameChar(line[p])) p++
  const name = line.slice(nameStart, p).toLowerCase()
  const attrs: Array<[string, string]> = []
  for (;;) {
    const gap = p
    while (p < limit && isBlank(line[p])) p++
    const spaced = p > gap
    if (p < limit && line[p] === '>')
      return { end: p + 1, tag: { name, closing, selfClosing: false, attrs } }
    if (p + 1 < limit && line[p] === '/' && line[p + 1] === '>') {
      return { end: p + 2, tag: { name, closing, selfClosing: true, attrs } }
    }
    if (!spaced || p >= limit || !isAttrStart(line[p])) return null
    const attrStart = p
    while (p < limit && isAttrChar(line[p])) p++
    const attr = line.slice(attrStart, p).toLowerCase()
    let q = p
    while (q < limit && isBlank(line[q])) q++
    if (q >= limit || line[q] !== '=') {
      attrs.push([attr, ''])
      continue
    }
    q++
    while (q < limit && isBlank(line[q])) q++
    if (q >= limit) return null
    const quote = line[q]
    if (quote === '"' || quote === "'") {
      const close = indexBefore(line, quote, q + 1, limit)
      if (close < 0) return null
      attrs.push([attr, line.slice(q + 1, close)])
      p = close + 1
    } else {
      const valueStart = q
      while (q < limit && isUnquoted(line[q])) q++
      if (q === valueStart) return null
      attrs.push([attr, line.slice(valueStart, q)])
      p = q
    }
  }
}

/**
 * The construct `tryInlineHtml` reads at the `<` at `at`, on this line only:
 * a CDATA section, a processing instruction, a declaration or a tag (a
 * comment has its own masks).
 */
function readConstruct(line: string, at: number, closers: Closers): Construct | null {
  const limit = Math.min(line.length, at + RAW_HTML_BOUND)
  const next = line[at + 1]
  if (next === '!') {
    if (line.startsWith('<![CDATA[', at)) {
      const close = closers.cdata(at + 9)
      return close < 0 || close + 3 > limit ? null : { end: close + 3, tag: null }
    }
    if (!isLetter(line[at + 2])) return null
    const close = closers.declaration(at + 3)
    return close < 0 || close + 1 > limit ? null : { end: close + 1, tag: null }
  }
  if (next === '?') {
    const close = closers.instruction(at + 2)
    return close < 0 || close + 2 > limit ? null : { end: close + 2, tag: null }
  }
  return readTag(line, at, limit)
}

/** `<` that could open a tag, a closing tag, a declaration or a processing instruction. */
function opensConstruct(line: string, at: number): boolean {
  const next = line[at + 1]
  if (isLetter(next)) return true
  if (next === '/') return isLetter(line[at + 2])
  if (next === '!') return !line.startsWith('--', at + 2)
  return next === '?'
}

/**
 * A handled tag's name with a blank, `/` or `>` (or the line's end) after it:
 * it may close on a later line, and the editor reads it then as it does now.
 */
function namesHandledTag(line: string, at: number): { name: string; closing: boolean } | null {
  let p = at + 1
  const closing = line[p] === '/'
  if (closing) p++
  const start = p
  while (isNameChar(line[p])) p++
  const name = line.slice(start, p).toLowerCase()
  const after = line[p]
  return HANDLED_TAGS.has(name) &&
    (after === undefined || isBlank(after) || after === '/' || after === '>')
    ? { name, closing }
    : null
}

/** The handled tags a scan has left open. */
interface Nesting {
  /** For each `<span>` still open, whether it has a `style`. */
  spans: boolean[]
  /** For each handled tag still open, by name, whether the cap made it text. */
  open: Map<string, boolean[]>
  /** The open handled tags the cap did not make text. */
  depth: number
}

/**
 * Counts a handled tag toward the nesting and says whether it is still within
 * the cap. A closing tag belongs to the innermost open tag of its name, and is
 * text when that tag is; one that closes nothing is read as it was.
 */
function withinNesting(name: string, closing: boolean, nesting: Nesting): boolean {
  if (VOID_TAGS.has(name)) return true
  let stack = nesting.open.get(name)
  if (stack === undefined) {
    stack = []
    nesting.open.set(name, stack)
  }
  if (closing) {
    const capped = stack.pop()
    if (capped === false) nesting.depth--
    return capped !== true
  }
  const capped = nesting.depth >= RAW_HTML_MAX_NESTING
  stack.push(capped)
  if (!capped) nesting.depth++
  return !capped
}

/**
 * Whether the editor handles `tag`, within the nesting cap. `nesting.spans`
 * holds, for each `<span>` still open, whether it has a `style`: a `</span>`
 * belongs to the innermost one, and one closing a plain span, or nothing, is
 * text.
 */
function isHandled(tag: Tag, nesting: Nesting): boolean {
  return readsAsHandled(tag, nesting.spans) && withinNesting(tag.name, tag.closing, nesting)
}

function readsAsHandled(tag: Tag, open: boolean[]): boolean {
  const has = (name: string): boolean => tag.attrs.some(([attr]) => attr === name)
  switch (tag.name) {
    case 'span': {
      if (tag.closing) return open.pop() === true
      const styled = has('style')
      if (!tag.selfClosing) open.push(styled)
      return styled
    }
    case 'details':
      return !tag.closing && has('data-memry-toggle')
    case 'input':
      return (
        !tag.closing &&
        tag.attrs.some(([attr, value]) => attr === 'type' && value.toLowerCase() === 'checkbox')
      )
    default:
      return HANDLED_TAGS.has(tag.name)
  }
}

/** Where the first non-blank character after a link's `](` is, or -1. */
function addressStart(line: string, close: number): number {
  if (line[close + 1] !== '(') return -1
  let at = close + 2
  while (isBlank(line[at])) at++
  return at
}

function scanLine(
  line: string,
  base: number,
  markdown: boolean,
  nesting: Nesting,
  spans: RawHtmlSpan[]
): void {
  // The `[` this line has left open, and where the address of the last link
  // starts: `[a](<x y>)` is a destination the link mask reads.
  let depth = 0
  let address = -1
  const closers: Closers = {
    cdata: finder(line, ']]>'),
    instruction: finder(line, '?>'),
    declaration: finder(line, '>')
  }
  for (let at = 0; at < line.length; at++) {
    const ch = line[at]
    if (ch === '<') {
      if (!opensConstruct(line, at) || at === address) continue
      const found = readConstruct(line, at, closers)
      if (found === null) {
        const named = namesHandledTag(line, at)
        if (named === null || !withinNesting(named.name, named.closing, nesting)) {
          spans.push({ start: base + at, end: base + at + 1 })
        }
        continue
      }
      if (found.tag !== null && isHandled(found.tag, nesting)) {
        at = found.end - 1
        continue
      }
      // A row splits at a pipe before it reads a tag.
      if (line.slice(at, found.end).includes('|')) {
        spans.push({ start: base + at, end: base + at + 1 })
        continue
      }
      spans.push({ start: base + at, end: base + found.end })
      at = found.end - 1
    } else if (!markdown) {
      continue
    } else if (ch === '\\') {
      if (at + 1 < line.length && ESCAPABLE.includes(line[at + 1])) at++
    } else if (ch === '`') {
      let run = at
      while (line[run] === '`') run++
      const length = run - at
      let close = -1
      for (let from = run; from < line.length && close < 0;) {
        const tick = line.indexOf('`', from)
        if (tick < 0) break
        let end = tick
        while (line[end] === '`') end++
        if (end - tick === length) close = end
        from = end
      }
      at = close < 0 ? run - 1 : close - 1
    } else if (ch === '[') {
      depth++
    } else if (ch === ']' && depth > 0) {
      depth--
      address = addressStart(line, at)
    }
  }
}

/**
 * The hidden ranges of `text`, in order. In `markdown` mode `text` is a note
 * and its fences, code spans, backslash escapes and link addresses are read; in
 * text mode it is the characters of a text run, which the writer spells.
 */
export function scanRawHtml(text: string, markdown: boolean): RawHtmlSpan[] {
  const spans: RawHtmlSpan[] = []
  if (!text.includes('<')) return spans
  const nesting: Nesting = { spans: [], open: new Map(), depth: 0 }
  const fence = markdown ? createFenceTracker() : null
  let base = 0
  for (const line of text.split('\n')) {
    if (!(fence?.consume(line) ?? false) && line.includes('<')) {
      scanLine(line, base, markdown, nesting, spans)
    }
    base += line.length + 1
  }
  return spans
}

/** The tags `text` spells whole, which the writer must leave as they are. */
export function spelledTags(text: string): RawHtmlSpan[] {
  return scanRawHtml(text, false).filter((span) => span.end - span.start > 1)
}

export interface MaskedRawHtml {
  markdown: string
  /** The characters each token replaced, by index. Empty when nothing was masked. */
  sources: string[]
}

/** `markdown` with every `<` that opens raw HTML the editor does not handle hidden. */
export function maskRawHtml(markdown: string): MaskedRawHtml {
  const spans = scanRawHtml(markdown, true)
  if (spans.length === 0) return { markdown, sources: [] }
  const sources: string[] = []
  let out = ''
  let last = 0
  for (const { start, end } of spans) {
    out += markdown.slice(last, start) + placeholder(sources.push(markdown.slice(start, end)) - 1)
    last = end
  }
  return { markdown: out + markdown.slice(last), sources }
}

/**
 * `text` with the tokens `maskRawHtml` made turned back into their characters.
 * Called before the restores of the masks that ran earlier, whose placeholders
 * a hidden tag may hold.
 */
export function restoreRawHtml(text: string, sources: string[]): string {
  if (sources.length === 0 || !text.includes(PLACEHOLDER_PREFIX)) return text
  return text.replace(PLACEHOLDER, (whole, index: string) => sources[Number(index)] ?? whole)
}
