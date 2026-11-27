/**
 * Where BlockNote's parser (`markdownToHtml.ts` `tokenize`) starts a block of
 * its own, for the lines a custom block opens on: `>` and `$$`.
 *
 * The readers wanted a blank line above, so `# H\n> [!tip]\n> d` seeded a quote
 * holding the text `[!tip]`. Its canonical form puts a blank line between the
 * two blocks, so the next seed of the same note read a callout.
 */

const QUOTE_LINE = /^\s{0,3}>/
const HEADING = /^#{1,6}(?:\s|$)/
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const TABLE_ROW = /^\s*\|(?:.+\|)+\s*$/
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/**
 * True when `lines[i]` opens a block, `first` being the first line the same
 * parse reads (the lines above it belong to blocks already claimed).
 *
 * A quote ends any paragraph, list item, heading or table above it, so `>`
 * opens a block unless the line above is its own quote's. After a quote's
 * lazy lines it opens another quote, unlike CommonMark. Any other line opens
 * one where the block above takes no more lines: a heading, a thematic break,
 * a closed fence, a list item or a table. A paragraph and a quote's lazy
 * lines take it in.
 */
export function opensBlock(lines: readonly string[], i: number, first: number): boolean {
  if (i <= first) return true
  const above = lines[i - 1]
  if (QUOTE_LINE.test(lines[i])) return !QUOTE_LINE.test(above)
  if (above.trim() === '' || HEADING.test(above) || FENCE.test(above) || RULE.test(above)) {
    return true
  }
  // An item's own lines are indented past its marker; a line flush left ends it.
  let item = i - 1
  while (item > first && /^\s+\S/.test(lines[item])) item--
  if (LIST_ITEM.test(lines[item])) return true
  // A table runs on while each line holds a pipe.
  for (let row = i - 1; row > first && lines[row].includes('|'); row--) {
    if (TABLE_DELIMITER.test(lines[row]) && lines[row - 1].includes('|')) return true
  }
  return false
}

/**
 * True when BlockNote ends a paragraph before `line`: a blank line, a heading,
 * a fence, a quote, a thematic break, a list item, a table row or an HTML
 * comment. A dashed rule is left out, since under a paragraph it is a setext
 * underline that makes the paragraph a heading.
 */
export function endsParagraphBefore(line: string | undefined): boolean {
  if (line === undefined || line.trim() === '') return true
  if (/^\s{0,3}-+\s*$/.test(line)) return false
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE_LINE.test(line) ||
    RULE.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_ROW.test(line) ||
    /^\s{0,3}<!--/.test(line)
  )
}
