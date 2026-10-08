import { BLOCK_COLORS_LINE_REGEX, TABLE_CELL_COLORS_LINE_REGEX } from './block-colors.ts'
import { BLOCK_ALIGN_LINE_REGEX, TABLE_LAYOUT_LINE_REGEX } from './block-markers.ts'
import { replaceMarkdownComments } from './markdown-code.ts'

/**
 * HTML comments, carried through the editor as an inline `htmlComment` node
 * (AF-015). Obsidian `%% … %%` comments ride the same node (BBF-26).
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
 *
 * The prefix ends in a word drawn once per process, so note text cannot hold a
 * token (BBF-30). That holds because a token never leaves the process that
 * made it: the parse turns every one into a node, and the serializer's tokens
 * are decoded in the same process.
 */

function processWord(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return String.fromCharCode(...Array.from(bytes, (byte) => 65 + (byte % 26)))
}

const TOKEN_PREFIX = `MEMRYCMT${processWord()}`
const TOKEN_REGEX = new RegExp(`${TOKEN_PREFIX}([0-9a-f]*)X`, 'g')

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
 * Every HTML and `%% … %%` comment outside code replaced by its token, with
 * the boundaries `replaceMarkdownComments` reads. Both forms become the same
 * `htmlComment` node, whose `source` keeps its own delimiters. An indented
 * code block is not told apart here: a comment inside one is masked and comes
 * back as the code block's own text (`parseMarkdownToBlocksRepaired`).
 */
export function maskHtmlComments(markdown: string): string {
  return replaceMarkdownComments(markdown, (source, wholeLine) =>
    isMemryMarker(source, wholeLine) ? source : encodeHtmlCommentToken(source)
  )
}
