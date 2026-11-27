import { encodeHtmlCommentToken } from '@memry/shared/html-comments'
import { maskMarkdownCode } from '@memry/shared/markdown-code'

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
 * code block is code, and one whose address crosses a line break stays as it
 * was, since the line is the unit a block's parse and its lists read.
 */

/** `[` followed by blanks, `]` and `(`: the only place a label can be empty. */
const OPENS_EMPTY_LABEL = /\[[ \t]*\]\(/

/**
 * Each `(` with the `)` that brings its depth back to zero, as
 * `findClosingParen` finds it, in one pass: a backslash and the character
 * after it are stepped over, and an opener no closer matches has none.
 */
function parenPartners(text: string): Map<number, number> {
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

/** `markdown` with each empty-label link outside code replaced by its token. */
export function maskEmptyLinks(markdown: string): string {
  if (!OPENS_EMPTY_LABEL.test(markdown)) return markdown
  const code = maskMarkdownCode(markdown)
  const partners = parenPartners(markdown)
  const link = /\[[ \t]*\]\(/y
  let out = ''
  let last = 0
  let bang = false
  let lineEnd = -1
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
    if (ch !== '[' || image || code[at] !== '[') continue
    link.lastIndex = at
    const opener = link.exec(markdown)
    if (!opener) continue
    if (lineEnd < at) {
      const found = markdown.indexOf('\n', at)
      lineEnd = found < 0 ? markdown.length : found
    }
    const close = partners.get(at + opener[0].length - 1)
    if (close === undefined || close > lineEnd) continue
    out += markdown.slice(last, at) + encodeHtmlCommentToken(markdown.slice(at, close + 1))
    last = close + 1
    at = close
  }
  return out + markdown.slice(last)
}
