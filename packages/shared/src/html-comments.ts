import { createFenceTracker } from './markdown-fences.ts'
import { BLOCK_COLORS_LINE_REGEX, TABLE_CELL_COLORS_LINE_REGEX } from './block-colors.ts'
import { BLOCK_ALIGN_LINE_REGEX, TABLE_LAYOUT_LINE_REGEX } from './block-markers.ts'

/**
 * HTML comments, carried through the editor as an inline `htmlComment` node
 * (AF-015).
 *
 * BlockNote has no node for a comment, so its markdown parser drops every one,
 * and only the source record (#1915) brought the bytes back, for regions the
 * document had not changed. An edit beside a comment, or a house-style
 * write-back, wrote the note without it, and the hidden links inside it went
 * with it.
 *
 * So a comment travels as a token: masked before the parse into one word of
 * hex the parser cannot touch, turned into an `htmlComment` node once the
 * blocks exist, and written back by the serializer as the same token, which
 * `decodeHtmlCommentTokens` turns back into the exact bytes. One word, because
 * a multi-line comment holding blank lines, a fence or a list must never be
 * seen by the line splitters that run before the parse.
 */

const TOKEN_PREFIX = 'MEMRYCMT'
const TOKEN_REGEX = /MEMRYCMT([0-9a-f]*)X/g

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeHtmlCommentToken(source: string): string {
  let hex = ''
  for (const byte of encoder.encode(source)) hex += byte.toString(16).padStart(2, '0')
  return `${TOKEN_PREFIX}${hex}X`
}

function decodeHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return decoder.decode(bytes)
}

export function hasHtmlCommentToken(text: string): boolean {
  return text.includes(TOKEN_PREFIX)
}

/** Every token in `text` replaced by the comment it carries. */
export function decodeHtmlCommentTokens(text: string): string {
  if (!hasHtmlCommentToken(text)) return text
  return text.replace(TOKEN_REGEX, (_token, hex: string) => decodeHex(hex))
}

export type HtmlCommentPart = { kind: 'text'; text: string } | { kind: 'comment'; source: string }

/** `text` cut at its tokens, empty text parts left out. */
export function splitHtmlCommentTokens(text: string): HtmlCommentPart[] {
  const parts: HtmlCommentPart[] = []
  let last = 0
  for (const match of text.matchAll(TOKEN_REGEX)) {
    const at = match.index ?? 0
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) })
    parts.push({ kind: 'comment', source: decodeHex(match[1]) })
    last = at + match[0].length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

const NESTING_MARKER_REGEX = /^<!--\s*memry:block-nesting-level=(\d+)\s*-->$/
const FILE_MARKER_REGEX = /^<!-- file:\{[^}]+\} -->$/
const WRITING_MARKER_REGEX = /^<!--\s*\/?(?:alt|ghost)(?::[A-Za-z0-9_-]{1,64})?\s*-->$/

const MARKER_LINE_REGEXES = [
  FILE_MARKER_REGEX,
  NESTING_MARKER_REGEX,
  BLOCK_COLORS_LINE_REGEX,
  TABLE_CELL_COLORS_LINE_REGEX,
  BLOCK_ALIGN_LINE_REGEX,
  TABLE_LAYOUT_LINE_REGEX
]

/**
 * Memry's own marker comments keep the parsers that read them: a sidecar,
 * file or nesting marker on a line of its own, and a writing tools marker
 * anywhere.
 */
function isMemryMarker(comment: string, wholeLine: boolean): boolean {
  if (WRITING_MARKER_REGEX.test(comment)) return true
  return wholeLine && MARKER_LINE_REGEXES.some((regex) => regex.test(comment))
}

/**
 * Every HTML comment outside code replaced by its token.
 *
 * Fenced code and code spans are left as written, and so is a `<!--` that
 * never closes, which CommonMark reads as text. A comment that opens before a
 * backtick wins over it, as in `blankMarkdownCode`. An indented code block is
 * not told apart here: a comment inside one is masked and comes back as the
 * code block's own text (`parseMarkdownToBlocksRepaired`).
 */
export function maskHtmlComments(markdown: string): string {
  if (!markdown.includes('<!--')) return markdown

  const lines = markdown.split('\n')
  const fence = createFenceTracker()
  const out: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (fence.consume(line)) {
      out.push(line)
      continue
    }
    let current = line
    let result = ''
    let i = 0
    for (;;) {
      const tick = current.indexOf('`', i)
      const open = current.indexOf('<!--', i)
      if (open === -1) break
      if (tick !== -1 && tick < open) {
        let runEnd = tick
        while (current[runEnd] === '`') runEnd++
        const close = findClosingRun(current, runEnd, runEnd - tick)
        if (close === -1) {
          i = runEnd
          continue
        }
        i = close + (runEnd - tick)
        continue
      }
      const closeAt = findCommentClose(lines, index, current, open)
      if (closeAt === null) break
      const { endLine, endColumn } = closeAt
      const comment =
        endLine === index
          ? current.slice(open, endColumn)
          : [
              current.slice(open),
              ...lines.slice(index + 1, endLine),
              lines[endLine].slice(0, endColumn)
            ].join('\n')
      const rest = endLine === index ? current.slice(endColumn) : lines[endLine].slice(endColumn)
      const wholeLine =
        result.trim() === '' &&
        current.slice(0, open).trim() === '' &&
        rest.trim() === '' &&
        endLine === index
      if (isMemryMarker(comment, wholeLine)) {
        result += current.slice(0, endColumn)
        current = current.slice(endColumn)
        i = 0
        continue
      }
      result += current.slice(0, open) + encodeHtmlCommentToken(comment)
      current = rest
      i = 0
      index = endLine
    }
    out.push(result + current)
  }
  return out.join('\n')
}

function findCommentClose(
  lines: readonly string[],
  index: number,
  current: string,
  open: number
): { endLine: number; endColumn: number } | null {
  const sameLine = current.indexOf('-->', open + 4)
  if (sameLine !== -1) return { endLine: index, endColumn: sameLine + 3 }
  for (let next = index + 1; next < lines.length; next++) {
    const close = lines[next].indexOf('-->')
    if (close !== -1) return { endLine: next, endColumn: close + 3 }
  }
  return null
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
