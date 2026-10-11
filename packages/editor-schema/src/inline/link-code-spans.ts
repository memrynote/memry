/**
 * A code span inside link text, kept as the link's own text (BBF-105).
 *
 * The editor cannot hold code inside a link: the code mark excludes every
 * other mark, so `[`a`](u)` parsed to code `a` with no link, and the next
 * write-back deleted the address from the file. The span is parsed as link
 * text with its backticks instead, and written back without escapes, so the
 * file keeps `[`a`](u)` and the editor shows the backticks inside the link.
 */

const LINK = /(<a\b[^>]*>)([\s\S]*?)(<\/a>)/gi
const CODE = /<code>([^<]*)<\/code>/gi
const SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g

/** CommonMark code span for `value`: a fence no backtick run in it matches, padded when needed. */
function codeSpan(value: string): string {
  let fence = '`'
  while (new RegExp(`(?<!\`)${fence}(?!\`)`).test(value)) fence += '`'
  const pad =
    /[^ ]/.test(value) && ((value.startsWith(' ') && value.endsWith(' ')) || /^`|`$/.test(value))
  return pad ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`
}

/** `html` with each code span inside a link written as backtick text. */
export function linkCodeAsText(html: string): string {
  return html.replace(
    LINK,
    (_link, open: string, inner: string, close: string) =>
      open + inner.replace(CODE, (_code, value: string) => codeSpan(value)) + close
  )
}

/** Each code-span-shaped run of `text`, as `[offset, length]`. */
export function codeSpanRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(SPAN)].map((match) => [match.index, match[0].length])
}
