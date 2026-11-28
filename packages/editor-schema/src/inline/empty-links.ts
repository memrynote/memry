import { encodeHtmlCommentToken } from '@memry/shared/html-comments'
import { type LegacyReading, maskMarkdownCode } from '@memry/shared/markdown-code'
import { maskCodeAcrossLines } from './code-mask'

/**
 * A link with no label, `[](u)`, kept as an `htmlComment` node.
 *
 * A link is a mark on text in the document, and a link with no text has none
 * to hold it: the parser kept the label and dropped the address, so
 * `x [](u) y` came back `x  y`, and a block that held only such a link read
 * back empty. The link travels as the token an HTML comment does, with its
 * bytes (`[`, spaces and tabs, `](`, the address and its title, `)`) as the
 * node's `source`, and the serializer writes them back as they were. The
 * core's seed does the same (`crates/memry-core/src/crdt/markdown_seed/inline.rs`).
 *
 * A blank label is the same case: it collapses to nothing at the edge of a
 * block. An image, `![](u)`, has its own node. A link inside a code span or a
 * code block is code. One whose address crosses a line break cannot be a node:
 * the line is the unit a block's parse and its lists read, and a token would
 * hide the lines after the first. It stays the text it was, with its `[` and
 * `]` escaped so the parse reads no link there (the parse dropped the whole link,
 * and a line of text lost it). The core's seed reads the same text
 * (`crates/memry-core/src/crdt/markdown_seed/inline.rs`).
 *
 * An address and an image are left as they are: the parse reads an address
 * and an alt as written, so a link in either is part of that text, not a link
 * (masked there, its blanks would hide where the address ends).
 */

/** `[` followed by blanks, `]` and `(`: the only place a label can be empty. */
const OPENS_EMPTY_LABEL = /\[[ \t]*\]\(/

/**
 * A fence opener at the start of a line, after the indent, quote and list
 * markers it can sit behind: what follows it on the line is the fence's info
 * string, which a link cannot be in. Block structure is not read here, so a
 * fence in a list item can look like indented code to `maskMarkdownCode`.
 */
export const FENCE_OPENER = /[ \t>*+\-\d.)]*(?:`{3,}|~{3,})/y

/**
 * Each `(` with the `)` that brings its depth back to zero, as
 * `findClosingParen` finds it, in one pass: a backslash and the character
 * after it are stepped over, and an opener no closer matches has none.
 */
export function parenPartners(text: string): Map<number, number> {
  const partners = new Map<number, number>()
  const open: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === '(') open.push(i)
    else if (ch === ')' && open.length > 0) partners.set(open.pop()!, i)
  }
  return partners
}

/**
 * Each `[` with the `]` that brings its depth back to zero, as
 * `findClosingBracket` finds it, in one pass: a backslash and the character
 * after it are stepped over, and an opener no closer matches has none.
 */
export function bracketPartners(text: string): { opens: Map<number, number>; closes: Uint8Array } {
  const opens = new Map<number, number>()
  const closes = new Uint8Array(text.length)
  const open: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === '[') open.push(i)
    else if (ch === ']' && open.length > 0) {
      opens.set(open.pop()!, i)
      closes[i] = 1
    }
  }
  return { opens, closes }
}

/**
 * `markdown` with each empty-label link outside code replaced by its token,
 * and the brackets of each one whose address crosses a line escaped.
 *
 * `legacy.html` reads it as origin/main did, for a source recorded beside a
 * document that build made: a code span within one line, an image and an
 * address read like the rest of the line, and a link whose address crosses a
 * line left as it was, which the parse then dropped whole. The document that
 * build made holds none of that link, so only the same reading proves the
 * source against it.
 */
export function maskEmptyLinks(markdown: string, legacy: LegacyReading = {}): string {
  if (!OPENS_EMPTY_LABEL.test(markdown)) return markdown
  const code = legacy.html ? maskMarkdownCode(markdown, legacy) : maskCodeAcrossLines(markdown)
  const partners = parenPartners(markdown)
  const { opens, closes } = bracketPartners(markdown)
  /** The `)` that closes the address after the label ending at `labelEnd`. */
  const addressEnd = (labelEnd: number | undefined): number | undefined =>
    labelEnd !== undefined && markdown[labelEnd + 1] === '('
      ? partners.get(labelEnd + 1)
      : undefined
  const link = /\[[ \t]*\]\(/y
  let out = ''
  let last = 0
  let bang = false
  let lineEnd = -1
  /** Where the fence opener on this line ends, or -1 when it has none. */
  let fenceEnd = -1
  for (let at = 0; at < markdown.length; at++) {
    const ch = markdown[at]
    if (ch === '\\') {
      at++
      bang = false
      continue
    }
    if (ch === '!') {
      bang = true
      continue
    }
    const image = bang
    bang = false
    // Past the address a label's `]` opens: an address is read as written.
    if (!legacy.html && ch === ']' && closes[at] === 1 && code[at] === ']') {
      at = addressEnd(at) ?? at
      continue
    }
    if (ch !== '[' || code[at] !== '[') continue
    if (image) {
      if (!legacy.html) at = addressEnd(opens.get(at)) ?? at
      continue
    }
    link.lastIndex = at
    const opener = link.exec(markdown)
    if (!opener) continue
    if (lineEnd < at) {
      const found = markdown.indexOf('\n', at)
      lineEnd = found < 0 ? markdown.length : found
      FENCE_OPENER.lastIndex = markdown.lastIndexOf('\n', at - 1) + 1
      fenceEnd = FENCE_OPENER.test(markdown) ? FENCE_OPENER.lastIndex : -1
    }
    const close = partners.get(at + opener[0].length - 1)
    if (close === undefined) continue
    if (close > lineEnd) {
      if (legacy.html) continue
      // A fence's info string holds no link, whatever its structure.
      if (fenceEnd >= 0 && at >= fenceEnd) continue
      // Both brackets, so the pair stays neutral to an enclosing label's `]`.
      // Escaped, its `]` closes nothing, and what follows is no address.
      const label = at + opener[0].length - 2
      out += `${markdown.slice(last, at)}\\${markdown.slice(at, label)}\\`
      last = label
      closes[label] = 0
      continue
    }
    out += markdown.slice(last, at) + encodeHtmlCommentToken(markdown.slice(at, close + 1))
    last = close + 1
    at = close
  }
  return out + markdown.slice(last)
}
