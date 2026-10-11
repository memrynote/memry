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
}

const DELIMITERS = { bold: '**', italic: '*', strike: '~~' } as const
export type EmphasisMark = keyof typeof DELIMITERS
/** A token's meaning: a mark around a run, or a code span's own bytes. */
export type Span = EmphasisMark | { code: string }
const MARKS = Object.keys(DELIMITERS) as EmphasisMark[]

// Per process, so note text does not hold a token (BBF-30).
const PROCESS_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
const openToken = (index: number): string => `MEMRYEMO${PROCESS_WORD}${index};`
const closeToken = (index: number): string => `MEMRYEMC${PROCESS_WORD}${index};`
const codeToken = (index: number): string => `MEMRYEMK${PROCESS_WORD}${index};`
const TOKEN = new RegExp(`MEMRYEM([OCK])${PROCESS_WORD}(\\d+);`, 'g')
const EDGES = /^((?:\\\n|\s)*)([\s\S]*?)((?:\\\n|\s)*)$/

function holds(item: InlineItem, mark: EmphasisMark): boolean {
  if (Array.isArray(item.content)) {
    const content = item.content as InlineItem[]
    return content.length > 0 && content.every((child) => holds(child, mark))
  }
  if (item.type === 'text') return item.styles?.[mark] === true && item.text !== ''
  return item.props?.[mark] === true
}

function without(item: InlineItem, mark: EmphasisMark): InlineItem {
  if (Array.isArray(item.content)) {
    return { ...item, content: (item.content as InlineItem[]).map((c) => without(c, mark)) }
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
  JSON.stringify(Object.entries(styles ?? {}).sort(([a], [b]) => a.localeCompare(b)))

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
 * A code span in link text is the link's own text (`link-code-spans.ts`).
 * Each travels as a token so the serializer escapes none of it (BBF-105).
 */
function codeTokens(items: InlineItem[], marks: Span[]): InlineItem[] {
  return items.map((item) => {
    if (item.type !== 'text' || item.styles?.code === true || !item.text?.includes('`')) return item
    let text = item.text
    for (const [at, length] of codeSpanRanges(text).reverse()) {
      const token = codeToken(marks.push({ code: text.slice(at, at + length) }) - 1)
      text = text.slice(0, at) + token + text.slice(at + length)
    }
    return { ...item, text }
  })
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
      out.push(
        Array.isArray(item.content)
          ? {
              ...item,
              content: joinTexts(
                tokenizeEmphasisRuns(codeTokens(item.content as InlineItem[], marks), marks)
              )
            }
          : item
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

/** Each token pair in `markdown` turned into its delimiters. */
export function restoreEmphasisRuns(markdown: string, marks: Span[]): string {
  const open: string[] = ['']
  let last = 0
  for (const token of markdown.matchAll(TOKEN)) {
    open[open.length - 1] += markdown.slice(last, token.index)
    last = token.index + token[0].length
    const span = marks[Number(token[2])]
    if (token[1] === 'K') {
      open[open.length - 1] += typeof span === 'object' ? span.code : ''
      continue
    }
    if (token[1] === 'O') {
      open.push('')
      continue
    }
    if (open.length === 1) continue
    const run = open.pop() ?? ''
    const delimiter = typeof span === 'string' ? DELIMITERS[span] : ''
    const [, before, content, after] = EDGES.exec(run) ?? []
    open[open.length - 1] += content ? `${before}${delimiter}${content}${delimiter}${after}` : run
  }
  // A pair the serializer cut short keeps its text, without delimiters.
  return open.join('') + markdown.slice(last)
}
