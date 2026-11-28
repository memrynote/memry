import { createFenceTracker } from './markdown-fences.ts'

/**
 * Markdown with every fenced or indented code block and inline code span blanked out, so a
 * scan for `[[…]]` reads only text that renders as a link (AF-006). A note that
 * documents link syntax in backticks drew an unresolved node on the graph.
 *
 * Comments are kept as written, code-looking text inside them included: a link
 * hidden in an HTML comment or an Obsidian `%% … %%` comment is a real link
 * (FB-011). A comment that opens before a backtick also wins over it, the way
 * CommonMark reads whichever construct starts first, so a stray backtick in a
 * comment cannot pair with one outside.
 *
 * A code span is matched within one line. A span broken across lines in one
 * paragraph is valid CommonMark but rare in notes, and a per-line match cannot
 * blank a run of lines because one backtick was left unclosed.
 */
export function blankMarkdownCode(markdown: string): string {
  if (!mayHoldCode(markdown)) return markdown
  return walkMarkdown(
    markdown,
    {},
    {
      codeLine: () => '',
      textOpen: (open) => open,
      codeSpan: () => ' ',
      comment: (source) => source
    }
  )
}

/**
 * `blankMarkdownCode` with every offset kept: code block lines and code spans become
 * spaces of the same length, so a match in the result is a match at the same
 * offset in the source.
 */
export function maskMarkdownCode(markdown: string, legacy: LegacyReading = {}): string {
  if (!mayHoldCode(markdown)) return markdown
  return walkMarkdown(markdown, legacy, {
    codeLine: (line) => ' '.repeat(line.length),
    textOpen: (open) => open,
    codeSpan: (source) => ' '.repeat(source.length),
    skippedTicks: (ticks) => ' '.repeat(ticks.length),
    comment: (source) => source
  })
}

/**
 * How an earlier build read the note, for a source recorded beside a document
 * that build made (`MarkdownSourceRecord`). `tables`: a table row's cells split
 * on a code span's pipe (`cellPipe`), as builds before lossless blocks did.
 * `html`: as builds before raw HTML stayed text did. A code span is a run
 * closed by the next run of exactly its length and no other, a backslash does
 * not stop a backtick opening one, and a fence opener's line holds spans like
 * any other, where the parser reads them its own way; every `</span>` closes a
 * coloured span; and the tags the editor has no node for are dropped.
 */
export interface LegacyReading {
  tables?: boolean
  html?: boolean
}

/**
 * Markdown with every HTML comment and `%% … %%` comment outside code removed,
 * for output a reader sees (PDF and HTML export). Code keeps its comment syntax
 * as text. A `%%` or `<!--` that never closes is text and stays.
 */
export function stripMarkdownComments(markdown: string): string {
  return replaceMarkdownComments(markdown, () => '')
}

/**
 * Every closed HTML or `%% … %%` comment outside code replaced by
 * `replace(source, wholeLine, blockGoesOn)`. `source` is the comment's exact
 * text, delimiters and line breaks included. `wholeLine` is true when a
 * one-line comment is alone on its line. `blockGoesOn` is true for an HTML
 * comment that opens a CommonMark HTML block with text after its `-->`: that
 * text is part of the block, not a paragraph. Code stays as written. A `<!--`
 * read as text, or one that never closes, becomes `textOpen`, except one that
 * never closes and opens an HTML block, which becomes `unclosedOpen`. The text
 * after it stays. `legacy` reads the note as an earlier build did, for a source
 * recorded beside a document that build made (`LegacyReading`).
 */
export function replaceMarkdownComments(
  markdown: string,
  replace: (source: string, wholeLine: boolean, blockGoesOn: boolean) => string,
  textOpen = '<!--',
  unclosedOpen = textOpen,
  legacy: LegacyReading = {}
): string {
  if (!markdown.includes('<!--') && !markdown.includes('%%')) return markdown
  return walkMarkdown(markdown, legacy, {
    codeLine: (line) => line,
    textOpen: (open) => (open === '<!--' ? textOpen : open),
    codeSpan: (source) => source,
    comment: (source, closed, wholeLine, blockGoesOn) =>
      closed
        ? replace(source, wholeLine, blockGoesOn)
        : (blockGoesOn ? unclosedOpen : textOpen) + source.slice('<!--'.length)
  })
}

/**
 * `<!--` is CommonMark raw HTML: it ends at the first `-->`, code or not, and
 * runs to the end of the note when none follows. An inline `<!--`, with text
 * before it on its line or on the line where an earlier comment closes, sits
 * in a paragraph that a fence interrupts, so when a fence comes before its
 * `-->` it is text (BBF-46, BBF-57). `%%` is Obsidian prose
 * syntax: on a later line only a `%%` outside code closes it, and with no
 * such partner it is text.
 */
const COMMENT_FORMS = [
  { open: '<!--', close: '-->', proseOnly: false },
  { open: '%%', close: '%%', proseOnly: true }
] as const

type CommentForm = (typeof COMMENT_FORMS)[number]

function mayHoldCode(markdown: string): boolean {
  return markdown.includes('`') || markdown.includes('~~~') || INDENTED_LINE.test(markdown)
}

/** Four columns of indent, a tab counting as the rest of its stop. */
const INDENTED = /^(?: {0,3}\t| {4})/
const INDENTED_LINE = new RegExp(INDENTED.source, 'm')

/**
 * A line that opens a CommonMark HTML block with a comment, after any
 * blockquote and list item markers that start the block inside them (BBF-89).
 * A `>` always takes the space or tab after it: left to the next marker's
 * indent, the same line also matched, so a failing line of `> -  >` markers
 * backtracked through every split, doubling its time with each marker.
 */
const HTML_BLOCK_COMMENT =
  /^(?: {0,3}(?:>(?:[ \t]|(?![ \t]))|(?:[-*+]|\d{1,9}[.)]) {1,4}(?! )))* {0,3}<!--/

/** A list item or footnote definition, whose indented lines are its content. */
const CONTAINER_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)]|\[\^[^\]\s]+\]:)(?:\s|$)/

interface Visitor {
  /** A line of a fenced or indented code block. */
  codeLine(line: string): string
  codeSpan(source: string): string
  /** The backticks of a run that come before the span the parser retries into: text. */
  skippedTicks?(ticks: string): string
  /** A comment opener that is text: it never closes, or is cut off by a fence or a cell. */
  textOpen(open: string): string
  /**
   * A whole comment, line breaks included when it spans lines. `closed` is
   * false for an HTML comment still open at the end of the note. `wholeLine`
   * is true for a one-line comment with nothing else on its line.
   * `blockGoesOn` is as in `replaceMarkdownComments`; for a comment that
   * never closes it is true when the comment opens an HTML block, which then
   * runs to the end of the note.
   */
  comment(source: string, closed: boolean, wholeLine: boolean, blockGoesOn: boolean): string
}

/**
 * One pass over the lines: fenced code, code spans and comments are each
 * handed to the visitor, everything else is kept. A comment's extent is
 * settled when it opens (`COMMENT_FORMS`), so a stray `50%%` cannot hide the
 * rest of a note.
 *
 * An indented line is code when it starts a block (first line, or after a
 * blank line or a fence) or continues one, the way the editor reads it
 * (BBF-68). It is text when it continues a paragraph, and inside a list item
 * or footnote definition, where indent marks the item's own content.
 */
function walkMarkdown(markdown: string, legacy: LegacyReading, visit: Visitor): string {
  const lines = markdown.split('\n')
  const fence = createFenceTracker()
  const out: string[] = []
  let pending: {
    prefix: string
    source: string
    close: CommentClose | null
    htmlBlock: boolean
    opensBlock: boolean
  } | null = null
  let blockStart = true
  let indentedCode = false
  let container = false

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    let result = ''
    let closesComment = false
    let htmlBlock = false

    if (pending) {
      if (pending.close?.line !== index) {
        pending.source += '\n' + line
        if (index === lines.length - 1)
          out.push(pending.prefix + visit.comment(pending.source, false, false, pending.opensBlock))
        continue
      }
      const { end } = pending.close
      const blockGoesOn = pending.opensBlock && line.slice(end).trim() !== ''
      result =
        pending.prefix +
        visit.comment(pending.source + '\n' + line.slice(0, end), true, false, blockGoesOn)
      htmlBlock = pending.htmlBlock
      pending = null
      line = line.slice(end)
      closesComment = true
    } else if (fence.consume(withoutCr(line))) {
      out.push(visit.codeLine(line))
      blockStart = true
      indentedCode = false
      continue
    } else if (line.trim() === '') {
      out.push(line)
      blockStart = true
      continue
    } else if (INDENTED.test(line) && !container && (blockStart || indentedCode)) {
      out.push(visit.codeLine(line))
      indentedCode = true
      continue
    } else if (!INDENTED.test(line)) {
      container = CONTAINER_START.test(line) || (container && !blockStart)
    }
    blockStart = false
    indentedCode = false
    if (!closesComment) htmlBlock = HTML_BLOCK_COMMENT.test(line)

    const tableRow = TABLE_ROW_LINE.test(line)
    const opens = commentOpens(line)
    let ticks: TickRuns | null = null
    let i = 0
    while (i < line.length) {
      const tick = nextTick(line, i, legacy.html)
      const opened = opens(i)
      if (tick === -1 && !opened) break

      if (opened && (tick === -1 || opened.at < tick)) {
        const { form, at } = opened
        const close = line.indexOf(form.close, at + form.open.length)
        // GFM splits a row into cells before it reads inline syntax, so a
        // comment in a cell ends in that cell or is text (BBF-51).
        if (tableRow && (close === -1 || close > cellPipe(line, at, legacy))) {
          result += line.slice(i, at) + visit.textOpen(form.open)
          i = at + form.open.length
          continue
        }
        if (close !== -1) {
          const end = close + form.close.length
          const textAfter = line.slice(end).trim() !== ''
          const wholeLine = !closesComment && !line.slice(0, at).trim() && !textAfter
          const blockGoesOn = opensHtmlBlock(htmlBlock, closesComment, i, form) && textAfter
          result +=
            line.slice(i, at) + visit.comment(line.slice(at, end), true, wholeLine, blockGoesOn)
          i = end
          continue
        }
        const inline = closesComment || line.slice(0, at).trim() !== ''
        // An HTML block ends on the line holding its `-->`, so a `<!--` after
        // that close is block text and cannot reach a later line (BBF-78).
        const reopened: boolean = htmlBlock && !form.proseOnly && (closesComment || i > 0)
        const later: CommentClose | 'text' | null = reopened
          ? 'text'
          : findLaterClose(lines, index, form, inline, legacy.html)
        if (later === 'text' || (form.proseOnly && !later)) {
          result += line.slice(i, at) + visit.textOpen(form.open)
          i = at + form.open.length
          continue
        }
        pending = {
          prefix: result + line.slice(i, at),
          source: line.slice(at),
          close: later,
          htmlBlock,
          opensBlock: opensHtmlBlock(htmlBlock, closesComment, i, form)
        }
        break
      }

      ticks ??= new TickRuns(line, legacy.html)
      const span = ticks.spanAt(tick)
      if (!span) {
        const runEnd = tickRunEnd(line, tick)
        result += line.slice(i, runEnd)
        i = runEnd
        continue
      }
      const skipped = line.slice(tick, span.start)
      result +=
        line.slice(i, tick) +
        (visit.skippedTicks ? visit.skippedTicks(skipped) : skipped) +
        visit.codeSpan(line.slice(span.start, span.end))
      i = span.end
    }
    if (pending) {
      if (index === lines.length - 1)
        out.push(pending.prefix + visit.comment(pending.source, false, false, pending.opensBlock))
      continue
    }
    result += line.slice(i)
    out.push(result)
  }
  return out.join('\n')
}

/** The comment scanned from `i` is the `<!--` that `HTML_BLOCK_COMMENT` matched. */
function opensHtmlBlock(
  htmlBlock: boolean,
  closesComment: boolean,
  i: number,
  form: CommentForm
): boolean {
  return htmlBlock && !closesComment && i === 0 && !form.proseOnly
}

/**
 * `opens(from)` is the first comment opener at or after `from`, for a `from`
 * that only moves forward along `line`. Each form's last hit stands until the
 * position passes it, and a miss stands for good, so the line is read once per
 * form however many backticks or comments it holds.
 */
function commentOpens(line: string): (from: number) => { form: CommentForm; at: number } | null {
  const found: number[] = COMMENT_FORMS.map(() => -2)
  return (from) => {
    let best: { form: CommentForm; at: number } | null = null
    COMMENT_FORMS.forEach((form, index) => {
      if (found[index] !== -1 && found[index] < from) found[index] = line.indexOf(form.open, from)
      const at = found[index]
      if (at !== -1 && (!best || at < best.at)) best = { form, at }
    })
    return best
  }
}

/** Same row test as `escapeWikiLinkPipesInTableRows`: both ends are pipes. */
const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/

/**
 * The next unescaped `|` after `from` that ends a cell, or the line's length.
 * A pipe inside `[[target|alias]]` is part of the link, and one inside a code
 * span is part of the span, as the table reader splits the row
 * (`maskCellCodeSpans`), a comment's text included: otherwise a comment
 * holding `` `x|y` `` read as crossing its cell, stayed raw HTML, and the
 * parser dropped it from the cell. Builds before lossless tables split on
 * that pipe, so a `legacy.tables` read does too.
 */
function cellPipe(line: string, from: number, legacy: LegacyReading): number {
  let depth = 0
  let ticks: TickRuns | null = null
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++
    } else if (line[i] === '`' && !legacy.tables) {
      ticks ??= new TickRuns(line, legacy.html)
      const span = ticks.spanAt(i)
      i = (span ? span.end : tickRunEnd(line, i)) - 1
    } else if (line.startsWith('[[', i)) {
      depth++
      i++
    } else if (depth > 0 && line.startsWith(']]', i)) {
      depth--
      i++
    } else if (line[i] === '|' && depth === 0) {
      return i
    }
  }
  return line.length
}

interface CommentClose {
  line: number
  end: number
}

/**
 * The close of a comment left open at the end of line `index`. A `%%` comment
 * skips fenced blocks and code spans, so a fence inside it is read whole and
 * the fence state after it is the state before it. An `inline` `<!--` is
 * `'text'` when a fence opens before its close.
 */
function findLaterClose(
  lines: readonly string[],
  index: number,
  form: CommentForm,
  inline: boolean,
  legacyHtml = false
): CommentClose | 'text' | null {
  const fence = createFenceTracker()
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next]
    if (fence.consume(withoutCr(line))) {
      if (form.proseOnly) continue
      if (inline) return 'text'
    }
    const at = form.proseOnly
      ? indexOutsideCodeSpans(line, form.close, legacyHtml)
      : line.indexOf(form.close)
    if (at !== -1) return { line: next, end: at + form.close.length }
  }
  return null
}

function indexOutsideCodeSpans(line: string, marker: string, legacyHtml: boolean): number {
  let ticks: TickRuns | null = null
  let i = 0
  for (;;) {
    const at = line.indexOf(marker, i)
    const tick = nextTick(line, i, legacyHtml)
    if (at === -1 || tick === -1 || at < tick) return at
    ticks ??= new TickRuns(line, legacyHtml)
    const span = ticks.spanAt(tick)
    i = span ? span.end : tickRunEnd(line, tick)
  }
}

/** The fence pattern cannot match past a CRLF note's trailing `\r`. */
function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * The first backtick at or after `from` that no backslash escapes, or -1. A
 * `legacy` read takes every backtick, as builds before the parser's reading did.
 */
function nextTick(line: string, from: number, legacy = false): number {
  let at = line.indexOf('`', from)
  if (legacy) return at
  while (at !== -1) {
    let slashes = 0
    while (line[at - 1 - slashes] === '\\') slashes++
    if (slashes % 2 === 0) return at
    at = line.indexOf('`', at + 1)
  }
  return -1
}

function tickRunEnd(line: string, tick: number): number {
  let end = tick
  while (line[end] === '`') end++
  return end
}

/**
 * The backtick runs of one line, found once, so that every opener asks what
 * follows it in log time instead of reading the line again.
 */
class TickRuns {
  private readonly starts: number[] = []
  private readonly ends: number[] = []
  /** The runs of each width, as indexes into `starts`. */
  private readonly byWidth = new Map<number, number[]>()
  // Assigned in the body, not as parameter properties: Node's type stripping
  // (the CLI, and scripts that import this file) rejects those.
  private readonly line: string
  private readonly legacy: boolean

  constructor(line: string, legacy = false) {
    this.line = line
    this.legacy = legacy
    for (
      let at = line.indexOf('`');
      at !== -1;
      at = line.indexOf('`', this.ends[this.ends.length - 1])
    ) {
      const end = tickRunEnd(line, at)
      const width = end - at
      const same = this.byWidth.get(width)
      if (same) same.push(this.starts.length)
      else this.byWidth.set(width, [this.starts.length])
      this.starts.push(at)
      this.ends.push(end)
    }
  }

  /** The index of the run that holds the backtick at `tick`. */
  private runAt(tick: number): number {
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (this.starts[mid] <= tick) low = mid
      else high = mid - 1
    }
    return low
  }

  /** The first run of `width` backticks after run `k`, as an index, or -1. */
  private firstAfter(width: number, k: number): number {
    const same = this.byWidth.get(width)
    if (!same) return -1
    let low = 0
    let high = same.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (same[mid] > k) high = mid
      else low = mid + 1
    }
    return low === same.length ? -1 : same[low]
  }

  /**
   * The code span that opens in the run of backticks at `tick`, or null when
   * the run is text. The parser reads a run of `n` as a span closed by the next
   * run of exactly `n`; with none, it retries from each later backtick of the
   * run against the shorter run left (`a``x b`c` is `a`, a span `x b`, then
   * `c`), so the comment scan has to see the same span, or it masks a comment
   * the parser then reads inside code. A run of three or more that opens the
   * line is a fence's, which the parser reads whole whatever its info string
   * holds, so it pairs only with a run of its own length.
   */
  spanAt(tick: number): { start: number; end: number } | null {
    const k = this.runAt(tick)
    const runEnd = this.ends[k]
    const length = runEnd - tick
    if (this.legacy) {
      const close = this.firstAfter(length, k)
      return close === -1 ? null : { start: tick, end: this.starts[close] + length }
    }
    const fenceOpener = length >= 3 && tick <= 3 && /^ *$/.test(this.line.slice(0, tick))
    for (let width = length; width >= (fenceOpener ? length : 1); width--) {
      const close = this.firstAfter(width, k)
      if (close !== -1) return { start: runEnd - width, end: this.starts[close] + width }
    }
    return null
  }
}
