import { createFenceTracker } from './markdown-fences.ts'

/**
 * Markdown with every fenced code block and inline code span blanked out, so a
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
  if (!markdown.includes('`') && !markdown.includes('~~~')) return markdown
  return walkMarkdown(markdown, {
    fenceLine: () => '',
    codeSpan: () => ' ',
    comment: (source) => source
  })
}

/**
 * Markdown with every HTML comment and `%% … %%` comment outside code removed,
 * for output a reader sees (PDF and HTML export). Code keeps its comment syntax
 * as text. A `%%` or `<!--` that never closes is text and stays.
 */
export function stripMarkdownComments(markdown: string): string {
  if (!markdown.includes('<!--') && !markdown.includes('%%')) return markdown
  return walkMarkdown(markdown, {
    fenceLine: (line) => line,
    codeSpan: (source) => source,
    comment: (source, closed) => (closed ? '' : source)
  })
}

const COMMENT_FORMS = [
  { open: '<!--', close: '-->' },
  { open: '%%', close: '%%' }
] as const

type CommentForm = (typeof COMMENT_FORMS)[number]

interface Visitor {
  fenceLine(line: string): string
  codeSpan(source: string): string
  /**
   * A whole comment, line breaks included when it spans lines. `closed` is
   * false for an HTML comment still open at the end of the note.
   */
  comment(source: string, closed: boolean): string
}

/**
 * One pass over the lines: fenced code, code spans and comments are each
 * handed to the visitor, everything else is kept. An HTML comment left open
 * runs to the end of the note, as CommonMark reads it; a `%%` with no closing
 * `%%` is not a comment, so a stray `50%%` cannot hide the rest of a note.
 */
function walkMarkdown(markdown: string, visit: Visitor): string {
  const lines = markdown.split('\n')
  const fence = createFenceTracker()
  const out: string[] = []
  let pending: { form: CommentForm; prefix: string; source: string } | null = null

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    let result = ''

    if (pending) {
      const close = line.indexOf(pending.form.close)
      if (close === -1) {
        pending.source += '\n' + line
        if (index === lines.length - 1)
          out.push(pending.prefix + visit.comment(pending.source, false))
        continue
      }
      const end = close + pending.form.close.length
      result = pending.prefix + visit.comment(pending.source + '\n' + line.slice(0, end), true)
      pending = null
      line = line.slice(end)
    } else if (fence.consume(line.endsWith('\r') ? line.slice(0, -1) : line)) {
      // The fence pattern cannot match past a CRLF note's trailing `\r`.
      out.push(visit.fenceLine(line))
      continue
    }

    let i = 0
    while (i < line.length) {
      const tick = line.indexOf('`', i)
      const opened = nextCommentOpen(line, i)
      if (tick === -1 && !opened) break

      if (opened && (tick === -1 || opened.at < tick)) {
        const { form, at } = opened
        const close = line.indexOf(form.close, at + form.open.length)
        if (close !== -1) {
          const end = close + form.close.length
          result += line.slice(i, at) + visit.comment(line.slice(at, end), true)
          i = end
          continue
        }
        if (form.open === '%%' && !closesLater(lines, index, form.close)) {
          result += line.slice(i, at + form.open.length)
          i = at + form.open.length
          continue
        }
        pending = { form, prefix: result + line.slice(i, at), source: line.slice(at) }
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
        out.push(pending.prefix + visit.comment(pending.source, false))
      continue
    }
    result += line.slice(i)
    out.push(result)
  }
  return out.join('\n')
}

function nextCommentOpen(line: string, from: number): { form: CommentForm; at: number } | null {
  let best: { form: CommentForm; at: number } | null = null
  for (const form of COMMENT_FORMS) {
    const at = line.indexOf(form.open, from)
    if (at !== -1 && (!best || at < best.at)) best = { form, at }
  }
  return best
}

function closesLater(lines: readonly string[], index: number, close: string): boolean {
  for (let next = index + 1; next < lines.length; next++) {
    if (lines[next].includes(close)) return true
  }
  return false
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
