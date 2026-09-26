/**
 * Remove every `<!-- … -->` comment from a string.
 *
 * Same matches as `text.replace(/<!--[\s\S]*?-->/g, '')`, but with `indexOf`
 * instead of a lazy regex: the regex rescans to the end of the input from every
 * unclosed `<!--`, which is quadratic on a note full of them.
 *
 * Repeats until stable, because one pass can re-form a comment from the text on
 * either side of a removed one: `<!-<!-- x -->- y -->` leaves `<!-- y -->`.
 */
export function stripHtmlComments(text: string): string {
  let current = text
  for (;;) {
    const next = stripHtmlCommentsOnce(current)
    if (next === current) return next
    current = next
  }
}

function stripHtmlCommentsOnce(text: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    if (open === -1) break
    const close = text.indexOf('-->', open + 4)
    if (close === -1) break
    out += text.slice(from, open)
    from = close + 3
  }
  return from === 0 ? text : out + text.slice(from)
}
