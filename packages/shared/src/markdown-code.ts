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
  return walkMarkdown(markdown, {
    codeLine: () => '',
    codeSpan: () => ' ',
    comment: (source) => source
  })
}

/**
 * `blankMarkdownCode` with every offset kept: code block lines and code spans become
 * spaces of the same length, so a match in the result is a match at the same
 * offset in the source.
 */
export function maskMarkdownCode(markdown: string): string {
  if (!mayHoldCode(markdown)) return markdown
  return walkMarkdown(markdown, {
    codeLine: (line) => ' '.repeat(line.length),
    codeSpan: (source) => ' '.repeat(source.length),
    comment: (source) => source
  })
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
 * `replace(source, wholeLine, opensHtmlBlock, after)`. `source` is the
 * comment's exact text, delimiters and line breaks included. `wholeLine` is
 * true when a one-line comment is alone on its line. `opensHtmlBlock` is true
 * for an HTML comment that starts a CommonMark HTML block, and `after` is the
 * rest of the line the comment closes on, which still belongs to that block.
 * Code and a comment that never closes stay as written.
 */
export function replaceMarkdownComments(
  markdown: string,
  replace: (source: string, wholeLine: boolean, opensHtmlBlock: boolean, after: string) => string
): string {
  if (!markdown.includes('<!--') && !markdown.includes('%%')) return markdown
  return walkMarkdown(markdown, {
    codeLine: (line) => line,
    codeSpan: (source) => source,
    comment: (source, closed, wholeLine, opensHtmlBlock, after) =>
      closed ? replace(source, wholeLine, opensHtmlBlock, after) : source
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

/** A line that opens a CommonMark HTML block with a comment. */
const HTML_BLOCK_COMMENT = /^ {0,3}<!--/

/** A list item or footnote definition, whose indented lines are its content. */
const CONTAINER_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)]|\[\^[^\]\s]+\]:)(?:\s|$)/

interface Visitor {
  /** A line of a fenced or indented code block. */
  codeLine(line: string): string
  codeSpan(source: string): string
  /**
   * A whole comment, line breaks included when it spans lines. `closed` is
   * false for an HTML comment still open at the end of the note. `wholeLine`
   * is true for a one-line comment with nothing else on its line.
   * `opensHtmlBlock` and `after` are as in `replaceMarkdownComments`.
   */
  comment(
    source: string,
    closed: boolean,
    wholeLine: boolean,
    opensHtmlBlock: boolean,
    after: string
  ): string
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
function walkMarkdown(markdown: string, visit: Visitor): string {
  const lines = markdown.split('\n')
  const fence = createFenceTracker()
  const out: string[] = []
  let pending: {
    prefix: string
    source: string
    close: CommentClose | null
    htmlBlock: boolean
    opensHtmlBlock: boolean
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
          out.push(pending.prefix + visit.comment(pending.source, false, false, false, ''))
        continue
      }
      const { end } = pending.close
      result =
        pending.prefix +
        visit.comment(
          pending.source + '\n' + line.slice(0, end),
          true,
          false,
          pending.opensHtmlBlock,
          line.slice(end)
        )
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
    let i = 0
    while (i < line.length) {
      const tick = line.indexOf('`', i)
      const opened = nextCommentOpen(line, i)
      if (tick === -1 && !opened) break

      if (opened && (tick === -1 || opened.at < tick)) {
        const { form, at } = opened
        const close = line.indexOf(form.close, at + form.open.length)
        // GFM splits a row into cells before it reads inline syntax, so a
        // comment in a cell ends in that cell or is text (BBF-51).
        if (tableRow && (close === -1 || close > cellPipe(line, at))) {
          result += line.slice(i, at + form.open.length)
          i = at + form.open.length
          continue
        }
        if (close !== -1) {
          const end = close + form.close.length
          const after = line.slice(end)
          const wholeLine = !closesComment && !line.slice(0, at).trim() && !after.trim()
          const opensBlock = opensHtmlBlock(htmlBlock, closesComment, i, form)
          result +=
            line.slice(i, at) +
            visit.comment(line.slice(at, end), true, wholeLine, opensBlock, after)
          i = end
          continue
        }
        const inline = closesComment || line.slice(0, at).trim() !== ''
        // An HTML block ends on the line holding its `-->`, so a `<!--` after
        // that close is block text and cannot reach a later line (BBF-78).
        const reopened: boolean = htmlBlock && !form.proseOnly && (closesComment || i > 0)
        const later: CommentClose | 'text' | null = reopened
          ? 'text'
          : findLaterClose(lines, index, form, inline)
        if (later === 'text' || (form.proseOnly && !later)) {
          result += line.slice(i, at + form.open.length)
          i = at + form.open.length
          continue
        }
        pending = {
          prefix: result + line.slice(i, at),
          source: line.slice(at),
          close: later,
          htmlBlock,
          opensHtmlBlock: opensHtmlBlock(htmlBlock, closesComment, i, form)
        }
        break
      }

      let runEnd = tick
      while (line[runEnd] === '`') runEnd++
      const closeAt = findClosingRun(line, runEnd, runEnd - tick)
      if (closeAt === -1) {
        result += line.slice(i, runEnd)
        i = runEnd
        continue
      }
      const end = closeAt + (runEnd - tick)
      result += line.slice(i, tick) + visit.codeSpan(line.slice(tick, end))
      i = end
    }
    if (pending) {
      if (index === lines.length - 1)
        out.push(pending.prefix + visit.comment(pending.source, false, false, false, ''))
      continue
    }
    result += line.slice(i)
    out.push(result)
  }
  return out.join('\n')
}

/**
 * The comment at `i` is the one `HTML_BLOCK_COMMENT` matched: the line opens a
 * block and nothing but indent comes before the comment.
 */
function opensHtmlBlock(
  htmlBlock: boolean,
  closesComment: boolean,
  i: number,
  form: CommentForm
): boolean {
  return htmlBlock && !closesComment && i === 0 && !form.proseOnly
}

function nextCommentOpen(line: string, from: number): { form: CommentForm; at: number } | null {
  let best: { form: CommentForm; at: number } | null = null
  for (const form of COMMENT_FORMS) {
    const at = line.indexOf(form.open, from)
    if (at !== -1 && (!best || at < best.at)) best = { form, at }
  }
  return best
}

/** Same row test as `escapeWikiLinkPipesInTableRows`: both ends are pipes. */
const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/

/**
 * The next unescaped `|` after `from` that ends a cell, or the line's length.
 * A pipe inside `[[target|alias]]` is part of the link.
 */
function cellPipe(line: string, from: number): number {
  let depth = 0
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++
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
  inline: boolean
): CommentClose | 'text' | null {
  const fence = createFenceTracker()
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next]
    if (fence.consume(withoutCr(line))) {
      if (form.proseOnly) continue
      if (inline) return 'text'
    }
    const at = form.proseOnly ? indexOutsideCodeSpans(line, form.close) : line.indexOf(form.close)
    if (at !== -1) return { line: next, end: at + form.close.length }
  }
  return null
}

function indexOutsideCodeSpans(line: string, marker: string): number {
  let i = 0
  for (;;) {
    const at = line.indexOf(marker, i)
    const tick = line.indexOf('`', i)
    if (at === -1 || tick === -1 || at < tick) return at
    let runEnd = tick
    while (line[runEnd] === '`') runEnd++
    const closeAt = findClosingRun(line, runEnd, runEnd - tick)
    i = closeAt === -1 ? runEnd : closeAt + (runEnd - tick)
  }
}

/** The fence pattern cannot match past a CRLF note's trailing `\r`. */
function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Start of the next backtick run exactly `length` long, or -1. */
function findClosingRun(line: string, from: number, length: number): number {
  let i = from
  while (i < line.length) {
    const start = line.indexOf('`', i)
    if (start === -1) return -1
    let end = start
    while (line[end] === '`') end++
    if (end - start === length) return start
    i = end
  }
  return -1
}
