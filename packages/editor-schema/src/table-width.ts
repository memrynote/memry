import { markdownToHTML } from '@blocknote/core'
import { MASK_WORD } from '@memry/shared/mask-word'
import { TABLE_DELIMITER } from './blocks/block-starts'

/**
 * A table as wide as its widest row.
 *
 * BlockNote sizes a table by its header row and drops every cell a body row
 * holds past it: `| a | b |` over `| 1 | 2 | 3 | extra |` kept `1` and `2`
 * and lost the rest from the document, and from the file on the next write of
 * the table. The header row gets an empty cell for each column it lacks
 * before the parse, so the extra cells become columns, and the writer spells
 * the wider header back. A header that was all blank stays blank, so a table
 * without a header row keeps none.
 *
 * Which lines BlockNote reads as a table is its tokenizer's decision, and a
 * line that only looks like a header row (inside a list item's first line, a
 * paragraph or a fence, or a delimiter row closing a table above it) must not
 * gain pipes. So the tokenizer is asked: the line under each delimiter row
 * whose header would widen gets a marker in its first cell, which no table
 * cuts, BlockNote prints the text once, and
 * only a marker printed in the first row of a table's body sits under that
 * table's header, since a body starts on the line after its delimiter row. The
 * marker never goes in the header itself: one there would stop a header spelled
 * like a delimiter row (`| --- |`) from closing a table above it. The probe
 * runs only when some table needs widening.
 */

// The prefix a blockquote strips from each of its lines before its content is
// tokenized again.
const QUOTE_PREFIX = /^\s{0,3}>\s?/

const marker = (index: number): string => `MEMRYTBL${MASK_WORD}${index}X`

/** `parsePipeCells`' cell count. */
function cellCount(line: string): number {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
  const content = inner.endsWith('|') ? inner.slice(0, -1) : inner
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\' && content[i + 1] === '|') i++
    else if (content[i] === '|') count++
  }
  return count
}

function quoteDepth(line: string): number {
  let depth = 0
  for (
    let rest = line, prefix = QUOTE_PREFIX.exec(rest);
    prefix;
    prefix = QUOTE_PREFIX.exec(rest)
  ) {
    rest = rest.slice(prefix[0].length)
    depth++
  }
  return depth
}

/** The line as the tokenizer inside `depth` quotes reads it. */
function unquote(line: string, depth: number): string {
  let rest = line
  for (let level = 0; level < depth; level++) {
    const prefix = QUOTE_PREFIX.exec(rest)
    if (!prefix) break
    rest = rest.slice(prefix[0].length)
  }
  return rest
}

interface Candidate {
  line: number
  depth: number
  header: number
  /** The cell count of each line that could be a body row, in order. */
  rows: number[]
}

/** Each header row a wider row below it could widen. */
function candidates(lines: string[]): Candidate[] {
  const found: Candidate[] = []
  for (let line = 0; line + 2 < lines.length; line++) {
    const depth = quoteDepth(lines[line])
    const header = unquote(lines[line], depth)
    const delimiter = unquote(lines[line + 1], depth)
    if (!header.includes('|')) continue
    if (!delimiter.includes('|') || !TABLE_DELIMITER.test(delimiter)) continue
    const rows: number[] = []
    for (let row = line + 2; row < lines.length; row++) {
      const body = unquote(lines[row], depth)
      if (!body.includes('|')) break
      rows.push(cellCount(body))
    }
    const width = cellCount(header)
    if (rows.some((cells) => cells > width)) found.push({ line, depth, header: width, rows })
  }
  return found
}

/** The row inside `depth` quotes with `text` printed in its first cell, which no table cuts. */
function withMarker(line: string, depth: number, text: string): string {
  const body = unquote(line, depth)
  const open = /^\s*\|?/.exec(body)?.[0] ?? ''
  return line.slice(0, line.length - body.length) + open + text + body.slice(open.length)
}

/** How many body rows the table whose first body row printed `text` has, or null when none did. */
function bodyRows(html: string, text: string): number | null {
  const at = html.indexOf(text)
  if (at < 0) return null
  const body = html.lastIndexOf('<tbody>', at)
  if (body < 0 || html.lastIndexOf('</tbody>', at) > body) return null
  if (html.slice(body, at).split('<tr>').length !== 2) return null
  return html.slice(body, html.indexOf('</tbody>', at)).split('<tr>').length - 1
}

export function widenTables(markdown: string): string {
  if (!markdown.includes('|')) return markdown
  const lines = markdown.split('\n')
  const found = candidates(lines)
  if (found.length === 0) return markdown

  const probe = [...lines]
  for (const [index, candidate] of found.entries()) {
    const row = candidate.line + 2
    probe[row] = withMarker(probe[row], candidate.depth, marker(index))
  }
  const html = markdownToHTML(probe.join('\n'))
  for (const [index, candidate] of found.entries()) {
    const rows = bodyRows(html, marker(index))
    if (rows === null) continue
    const width = Math.max(candidate.header, ...candidate.rows.slice(0, rows))
    if (width === candidate.header) continue
    // The new cells go before the outer pipe, each opening with a space, so a
    // `\` the header ends in never escapes a pipe it did not escape before.
    const end = lines[candidate.line].trimEnd()
    const open = end.endsWith('|') ? end.slice(0, -1) : end
    lines[candidate.line] = `${open}${' |'.repeat(width - candidate.header)} |`
  }
  return lines.join('\n')
}
