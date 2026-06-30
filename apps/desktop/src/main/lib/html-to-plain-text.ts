const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.charAt(0) === '#') {
      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint)
      }
      return match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

// Marks where a heading starts so a blank line can be restored before it after
// all other blank lines are collapsed. NUL never appears in feed HTML text.
const HEADING_MARK = '\u0000'

/**
 * Convert an HTML fragment (e.g. GitHub-rendered release notes from the
 * electron-updater atom feed) into readable plain text for the native update
 * dialog, which renders its `detail` field as plain text only.
 *
 * Bullets are single-spaced; a blank line is added only before section
 * headings (New Features, Bug Fixes…), so the non-scrollable dialog stays
 * compact instead of double-spacing every release-note item.
 */
export function htmlToPlainText(input: string): string {
  const withBreaks = input
    .replace(/<h[1-6][^>]*>/gi, HEADING_MARK)
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')

  // Strip tags in a loop until the string stops changing: a single pass can
  // leave a re-formed tag when removing one match brings its neighbours
  // together (e.g. `<<a>script>` collapses to `<script>` after one replace).
  let stripped = withBreaks
  let previous: string
  do {
    previous = stripped
    stripped = stripped.replace(/<[^>]+>/g, '')
  } while (stripped !== previous)

  return (
    decodeEntities(stripped)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n') // single-space everything (loose lists wrap each <li> in a <p>)
      // eslint-disable-next-line no-control-regex -- intentional control-char stripping
      .replace(/\n*\u0000/g, '\n\n') // blank line only before section headings
      .trim()
  )
}
