/**
 * BlockNote's markdown export wraps every text run in its own marks, so
 * `**alpha *x y* omega**` (bold `alpha `, bold italic `x y`, bold ` omega`)
 * came back as `**alpha** ***x y***** omega**`: the bold closed and reopened
 * around the italic, and ` omega` reopened on a space, which CommonMark does
 * not read as emphasis. A bold run that starts with a space after a code span
 * broke the same way: `` **`a` x `c`** `` became `` `a`** x** `c` `` (BBF-62).
 */

import { codeSpanRanges } from './link-code-spans'

type Styles = Record<string, unknown>
export type InlineItem = {
  type: string
  text?: string
  styles?: Styles
  props?: Styles
  content?: unknown
  href?: string
}

const DELIMITERS = { bold: '**', italic: '*', strike: '~~' } as const
export type EmphasisMark = keyof typeof DELIMITERS
/** A token's meaning: a mark around a run, or a code span's own bytes. */
export type Span = EmphasisMark | { code: string }
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.keys widens to string[]; DELIMITERS is the literal that defines EmphasisMark
const MARKS = Object.keys(DELIMITERS) as EmphasisMark[]

// Per process, so note text does not hold a token (BBF-30).
const PROCESS_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
const openToken = (index: number): string => `MEMRYEMO${PROCESS_WORD}${index};`
const closeToken = (index: number): string => `MEMRYEMC${PROCESS_WORD}${index};`
const codeToken = (index: number): string => `MEMRYEMK${PROCESS_WORD}${index};`
const TOKEN = new RegExp(`MEMRYEM([OCK])${PROCESS_WORD}(\\d+);`, 'g')
const underscoreToken = (index: number): string => `MEMRYEMU${PROCESS_WORD}${index};`
const UNDERSCORE_TOKEN = new RegExp(`MEMRYEMU${PROCESS_WORD}(\\d+);`, 'g')
// A break inside a quote carries the quote's `>` prefix onto the next line. A
// `<br>` ending a run is a break the escaper spelled for a paragraph's end.
const EDGES = /^((?:\\\n(?:[^\S\n]*>)*|\s)*)([\s\S]*?)((?:\\\n(?:[^\S\n]*>)*|<br>|\s)*)$/

function holds(item: InlineItem, mark: EmphasisMark): boolean {
  if (Array.isArray(item.content)) {
    const content: InlineItem[] = item.content
    return content.length > 0 && content.every((child) => holds(child, mark))
  }
  if (item.type === 'text') return item.styles?.[mark] === true && item.text !== ''
  return item.props?.[mark] === true
}

function without(item: InlineItem, mark: EmphasisMark): InlineItem {
  if (Array.isArray(item.content)) {
    const children: InlineItem[] = item.content
    return { ...item, content: children.map((c) => without(c, mark)) }
  }
  const drop = (styles: Styles | undefined): Styles | undefined => {
    if (!styles) return styles
    const { [mark]: _dropped, ...rest } = styles
    return rest
  }
  return item.type === 'text'
    ? { ...item, styles: drop(item.styles) }
    : { ...item, props: drop(item.props) }
}

function runLength(items: InlineItem[], from: number, mark: EmphasisMark): number {
  let end = from
  while (end < items.length && holds(items[end], mark)) end++
  return end - from
}

const styleKey = (styles: Styles | undefined): string =>
  JSON.stringify(Object.entries(styles ?? {}).toSorted(([a], [b]) => a.localeCompare(b)))

// BlockNote writes each text run of a link as its own link, so the tokens
// around `*b*` in `[a *b*](u)` would split it into four links (BBF-71).
function joinTexts(items: InlineItem[]): InlineItem[] {
  const out: InlineItem[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (
      item.type === 'text' &&
      last?.type === 'text' &&
      styleKey(last.styles) === styleKey(item.styles)
    ) {
      out[out.length - 1] = { ...last, text: `${last.text ?? ''}${item.text ?? ''}` }
    } else out.push(item)
  }
  return out
}

/**
 * BlockNote writes a link whose text holds a break as one link per line. Split
 * here first, the break outside the links, so no token pair spans the split:
 * `[**a**\nb](u)` wrote `[**a](u)\n[**b](u)` (BBF-104).
 */
function splitLinksAtBreaks(items: InlineItem[]): InlineItem[] {
  const out: InlineItem[] = []
  for (const item of items) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- content is `unknown`; a link's content is always an array, and an Array.isArray guard would turn a malformed item's throw into a silent skip
    const content = item.content as InlineItem[] | undefined
    if (item.type !== 'link' || !content?.some((child) => child.text?.includes('\n'))) {
      out.push(item)
      continue
    }
    let line: InlineItem[] = []
    const endLine = (): void => {
      if (line.length > 0) out.push({ ...item, content: line })
      line = []
    }
    for (const child of content) {
      for (const part of (child.text ?? '').split(/(\n+)/)) {
        if (part === '') continue
        if (!part.startsWith('\n')) {
          line.push({ ...child, text: part })
          continue
        }
        endLine()
        // The break keeps the run's marks, so a bold run across it stays one run.
        const { code: _code, ...styles } = child.styles ?? {}
        out.push({ ...child, text: part, styles })
      }
      if (child.type !== 'text') line.push(child)
    }
    endLine()
  }
  return out
}

/**
 * Each soft break in a list item's link text, as a token inside the link. Split
 * at the break, the second link lands on a lazy line that reads back as a
 * paragraph of its own, so `- [a\nb](u)` gained a blank line (BBF-106).
 */
export function listLinkBreakTokens(items: InlineItem[], marks: Span[]): InlineItem[] {
  return items.map((item) => {
    if (item.type !== 'link' || !Array.isArray(item.content)) return item
    const linkChildren: InlineItem[] = item.content
    const content = linkChildren.map((child) =>
      child.text?.includes('\n')
        ? {
            ...child,
            text: child.text.replace(/(?<!\n)\n(?!\n)/g, () =>
              codeToken(marks.push({ code: '\n' }) - 1)
            )
          }
        : child
    )
    return { ...item, content }
  })
}

/**
 * A code span in link text is the link's own text (`link-code-spans.ts`).
 * Each travels as a token so the serializer escapes none of it (BBF-105).
 */
function codeTokens(items: InlineItem[], marks: Span[]): InlineItem[] {
  return items.map((item) => {
    if (item.type !== 'text' || item.styles?.code === true || !item.text?.includes('`')) return item
    let text = item.text
    for (const [at, length] of codeSpanRanges(text).toReversed()) {
      const token = codeToken(marks.push({ code: text.slice(at, at + length) }) - 1)
      text = text.slice(0, at) + token + text.slice(at + length)
    }
    return { ...item, text }
  })
}

/**
 * The serializer escapes each parenthesis and backslash of a link address, and
 * the parser keeps both as written, so `[a](u(y))` (BBF-107) and `[a](u\(y\))`
 * (BBF-108) gained backslashes on every save. An address whose unescaped
 * parentheses balance is valid as written, so it travels as tokens. So does an
 * `href` with whitespace, which is the destination and title as written
 * (`link-destinations.ts`, BBF-109). The serializer writes a link whose text
 * is its address as the bare address, which the parser reads as text, so that
 * address travels as one token and the link keeps its brackets.
 */
function hrefParenTokens(item: InlineItem, marks: Span[]): InlineItem {
  const href = item.href
  if (item.type !== 'link' || !href) return item
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- content is `unknown`; the caller passes a link, whose content is always an array
  const text = (item.content as InlineItem[]).map((child) => child.text ?? '').join('')
  if (text === href) return { ...item, href: codeToken(marks.push({ code: href }) - 1) }
  if (!/[\\()<>\s]/.test(href)) return item
  if (href !== href.trim() || href.includes('\n')) return item
  if (!/\s/.test(href) && href.startsWith('<')) return item
  let depth = 0
  for (let at = 0; at < href.length; at++) {
    if (href[at] === '\\') {
      if (++at === href.length) return item
    } else if (href[at] === '(') depth++
    else if (href[at] === ')' && --depth < 0) return item
  }
  if (depth !== 0) return item
  const token = (char: string): string => codeToken(marks.push({ code: char }) - 1)
  return { ...item, href: href.replace(/[\\()<>\s]/g, token) }
}

/**
 * A code run spelled with the shortest fence its backtick runs allow, as a
 * token. The writer fences with one backtick more than the longest run, and
 * three at a line start open a code block: `c``c` came back as one. A run
 * that holds a break is left to the writer, which splits it at the break.
 */
function shortFencedCode(item: InlineItem, marks: Span[]): InlineItem {
  const text = item.text ?? ''
  if (item.type !== 'text' || item.styles?.code !== true || text.includes('\n')) return item
  const runs = new Set((text.match(/`+/g) ?? []).map((run) => run.length))
  let fence = 1
  while (runs.has(fence)) fence++
  if (fence > Math.max(0, ...runs)) return item
  const ticks = '`'.repeat(fence)
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text
  const { code: _code, ...styles } = item.styles
  return { ...item, text: codeToken(marks.push({ code: `${ticks}${padded}${ticks}` }) - 1), styles }
}

/** `items` with every run of a mark between tokens; `marks` maps each token to its span. */
export function tokenizeEmphasisRuns(items: InlineItem[], marks: Span[]): InlineItem[] {
  items = splitLinksAtBreaks(items)
  const out: InlineItem[] = []
  let at = 0
  while (at < items.length) {
    let best: { mark: EmphasisMark; length: number } | null = null
    // Ties keep BlockNote's own nesting order, so a lone `***x***` is unchanged.
    for (const mark of MARKS) {
      const length = runLength(items, at, mark)
      if (length > 0 && length > (best?.length ?? 0)) best = { mark, length }
    }
    if (!best) {
      const item = items[at++]
      const children: InlineItem[] = Array.isArray(item.content) ? item.content : []
      out.push(
        Array.isArray(item.content)
          ? {
              ...hrefParenTokens(item, marks),
              content: joinTexts(tokenizeEmphasisRuns(codeTokens(children, marks), marks))
            }
          : shortFencedCode(item, marks)
      )
      continue
    }
    const { mark, length } = best
    const index = marks.push(mark) - 1
    const run = items.slice(at, at + length).map((item) => without(item, mark))
    out.push({ type: 'text', text: openToken(index), styles: {} })
    out.push(...tokenizeEmphasisRuns(run, marks))
    out.push({ type: 'text', text: closeToken(index), styles: {} })
    at += length
  }
  return out
}

/**
 * Whether the parser misreads `delimiter` around `content`: three stars in a
 * row open bold italic (`tryBoldItalic`), so an italic run whose edge meets an
 * inner bold run (`***a** b*`, `*b **c***`) and a bold run ending in an inner
 * italic (`**b *c***`) came back as text with stray stars. A run that is one
 * inner run end to end (`lastRun`) is the `***x***` the parser reads, and an
 * escaped star (`*a\**`) meets no delimiter.
 */
function meetsInnerStars(delimiter: string, content: string, lastRun: string): boolean {
  if (content === lastRun) return false
  let slashes = 0
  while (content[content.length - 2 - slashes] === '\\') slashes++
  const endsInStar = content.endsWith('*') && slashes % 2 === 0
  if (delimiter === '*') return content.startsWith('*') || endsInStar
  return delimiter === '**' && endsInStar
}

/** `parseDelimited` skips an escaped character, so only a bare `_` could close an underscore run early. */
function hasBareUnderscore(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') i++
    else if (content[i] === '_') return true
  }
  return false
}

const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c)

/**
 * Whether a bare `_` before `at` in its paragraph could open a run, which would
 * close on an underscore delimiter at `at`. The escaper escapes those in text
 * (`spellsRunsWithUnderscores`), so this finds one in a code span or an address.
 */
function underscoreOpensBefore(markdown: string, at: number): boolean {
  let start = 0
  for (const blank of markdown.slice(0, at).matchAll(/\n[ \t>]*\n/g)) {
    start = blank.index + blank[0].length
  }
  for (let i = start; i < at; i++) {
    if (markdown[i] === '\\') i++
    else if (markdown[i] === '_' && !(isWord(markdown[i - 1]) && isWord(markdown[i + 1]))) {
      return true
    }
  }
  return false
}

/**
 * Each underscore token pair spelled `_` or `__`, or with the stars it stands
 * for where the parser would not read the underscores: `tryItalic` and
 * `tryBold` refuse an opener between two word characters, and no run closes
 * on an underscore next to another.
 */
function resolveUnderscores(markdown: string, delimiters: string[]): string {
  if (delimiters.length === 0) return markdown
  const openings = new Map<string, number>()
  const readable = new Set<string>()
  for (const token of markdown.matchAll(UNDERSCORE_TOKEN)) {
    const at = openings.get(token[1])
    if (at === undefined) {
      openings.set(token[1], token.index)
      continue
    }
    const before = markdown[at - 1]
    const first = markdown[at + token[0].length]
    const after = markdown[token.index + token[0].length]
    const opens = !(isWord(before) && isWord(first)) && before !== '_'
    if (opens && after !== '_' && !underscoreOpensBefore(markdown, at)) readable.add(token[1])
  }
  return markdown.replace(UNDERSCORE_TOKEN, (_token, index: string) => {
    const delimiter = delimiters[Number(index)]
    return readable.has(index) ? '_'.repeat(delimiter.length) : delimiter
  })
}

/** Each token pair in `markdown` turned into its delimiters. */
export function restoreEmphasisRuns(markdown: string, marks: Span[]): string {
  const { restored, underscored } = spellRuns(markdown, marks)
  return resolveUnderscores(restored, underscored)
}

/**
 * Whether house style spells a run of escaped `items` with underscores, see
 * `meetsInnerStars`, once every bare `_` in their text is escaped too.
 */
export function spellsRunsWithUnderscores(items: InlineItem[]): boolean {
  const spell = (list: InlineItem[]): string =>
    list
      .map((item) => {
        if (Array.isArray(item.content)) return `[${spell(item.content)}](${item.href ?? ''})`
        if (item.type !== 'text') return '\uFFFC'
        const text = item.text ?? ''
        if (item.styles?.code === true) return `\`${text}\``
        return text.replace(/\\[\s\S]|_/g, (match) => (match === '_' ? '\\_' : match))
      })
      .join('')
  const marks: Span[] = []
  return spellRuns(spell(tokenizeEmphasisRuns(items, marks)), marks).underscored.length > 0
}

/** `markdown` with each run's delimiters, an underscore token pair where `meetsInnerStars`. */
function spellRuns(markdown: string, marks: Span[]): { restored: string; underscored: string[] } {
  // `lastRun` is the last run closed inside each open one, delimiters included,
  // and `runEnd` the length of `text` right after it.
  const open = [{ text: '', lastRun: '', runEnd: -1 }]
  const underscored: string[] = []
  let last = 0
  for (const token of markdown.matchAll(TOKEN)) {
    const top = open[open.length - 1]
    top.text += markdown.slice(last, token.index)
    last = token.index + token[0].length
    const span = marks[Number(token[2])]
    if (token[1] === 'K') {
      top.text += typeof span === 'object' ? span.code : ''
      continue
    }
    if (token[1] === 'O') {
      open.push({ text: '', lastRun: '', runEnd: -1 })
      continue
    }
    if (open.length === 1) continue
    const run = open.pop() ?? top
    const parent = open[open.length - 1]
    const [, before, content, after] = EDGES.exec(run.text) ?? []
    if (!content) {
      parent.text += run.text
      continue
    }
    let delimiter: string = typeof span === 'string' ? DELIMITERS[span] : ''
    // Stars against the stars of the run before (`*a***b**`) open bold italic too.
    const touches = !before && parent.text.length === parent.runEnd && parent.lastRun.endsWith('*')
    const misread =
      meetsInnerStars(delimiter, content, run.lastRun) || (touches && delimiter.startsWith('*'))
    if (misread && !hasBareUnderscore(content)) {
      delimiter = underscoreToken(underscored.push(delimiter) - 1)
    }
    parent.lastRun = `${delimiter}${content}${delimiter}`
    parent.text += `${before}${parent.lastRun}`
    parent.runEnd = parent.text.length
    parent.text += after
  }
  // A pair the serializer cut short keeps its text, without delimiters.
  return { restored: open.map((run) => run.text).join('') + markdown.slice(last), underscored }
}

/**
 * `items` with the whitespace at each edge of a mark's run taken out of that
 * mark, as `restoreEmphasisRuns` writes it: markdown has no spelling for
 * `** x **`, so a bold run ending in a space came back with the space outside
 * the bold on the next seed (`**see ![x](u)** now` lifts the image and leaves
 * bold `see `). A space against a comment stays: it is how the writer
 * tells a comment inside the run from one beside it (`html-comment.ts`).
 */
export function trimEmphasisEdges(items: InlineItem[]): InlineItem[] {
  // A code span is written in backticks, so its spaces are never at the run's edge.
  const plainText = (item: InlineItem, beside: InlineItem | undefined): boolean =>
    item.type === 'text' && item.styles?.code !== true && beside?.type !== 'htmlComment'
  let out = items
  for (const mark of MARKS) {
    const trimmed: InlineItem[] = []
    let at = 0
    while (at < out.length) {
      const length = runLength(out, at, mark)
      if (length === 0) {
        trimmed.push(out[at++])
        continue
      }
      const run = out.slice(at, at + length)
      const first = run[0]
      const lead = plainText(first, out[at - 1])
        ? (/^[^\S\n]+/.exec(first.text ?? '')?.[0] ?? '')
        : ''
      if (lead) run[0] = { ...first, text: first.text?.slice(lead.length) }
      const last = run[run.length - 1]
      // Breaks after the space go with it: the writer moves both past the mark.
      const tail = plainText(last, out[at + length])
        ? (/[^\S\n]+\n*$/.exec(last.text ?? '')?.[0] ?? '')
        : ''
      if (tail) run[run.length - 1] = { ...last, text: last.text?.slice(0, -tail.length) }
      if (lead) trimmed.push({ ...without(first, mark), text: lead })
      trimmed.push(...run.filter((item) => item.type !== 'text' || item.text !== ''))
      if (tail) trimmed.push({ ...without(last, mark), text: tail })
      at += length
    }
    out = joinTexts(trimmed)
  }
  return out
}
