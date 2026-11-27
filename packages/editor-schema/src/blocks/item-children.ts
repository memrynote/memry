/**
 * A list item's quote, callout or math run, lifted out of the item into the
 * nesting-marker form the writer gives an item's blocks.
 *
 * BlockNote reads `- a\n\n  > [!tip]\n  > b` as an item holding a quote of the
 * text `[!tip]\nb`, and an item's `$$` lines as a paragraph, because the
 * readers that claim callouts, structured quotes and math see only lines at
 * the left edge. Obsidian renders both as the blocks they spell. The writer
 * puts an item's blocks under nesting markers at the left edge, where the next
 * seed of the same note claimed them. Lifting the run reads it as the writer
 * writes it.
 *
 * Only a run in a top-level item, after a blank line, is lifted. A deeper
 * item's run stays as BlockNote reads it.
 */

import { createBlockNestingMarker } from '@memry/shared/block-nesting'
import { createFenceTracker } from '@memry/shared/markdown-fences'
import { endsParagraphBefore } from './block-starts'

/** A top-level list item: its marker, and the spaces before its text when it has any. */
const ITEM = /^([-*+]|\d{1,9}[.)])(?:( {1,4})(?=\S)|[ \t]*$)/

const indentOf = (line: string): number => line.length - line.trimStart().length

/** `lines` with each lifted run between nesting markers, see the module comment. */
export function liftItemChildRuns(lines: readonly string[]): string[] {
  const out: string[] = []
  const fence = createFenceTracker()
  // The open top-level item's content column, or 0 outside a list.
  let column = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const afterBlank = i > 0 && lines[i - 1].trim() === ''
    if (fence.consume(line) || line.trim() === '') {
      out.push(line)
      continue
    }
    if (indentOf(line) === 0) {
      const item = ITEM.exec(line)
      // A line at the edge ends the item unless it continues the item's text.
      if (item) column = item[1].length + (item[2]?.length ?? 1)
      else if (afterBlank || endsParagraphBefore(line)) column = 0
      out.push(line)
      continue
    }
    const inner = line.slice(column)
    const lifts =
      column > 0 &&
      afterBlank &&
      indentOf(line) >= column &&
      (inner.startsWith('>') || inner === '$$')
    if (!lifts) {
      out.push(line)
      continue
    }
    let end = i
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) >= column)) end++
    while (lines[end - 1].trim() === '') end--
    const run = lines.slice(i, end)
    for (const runLine of run.slice(1)) fence.consume(runLine)
    out.push(createBlockNestingMarker(1), '', ...run.map((runLine) => runLine.slice(column)))
    out.push('', createBlockNestingMarker(0))
    if (end < lines.length && lines[end].trim() !== '') out.push('')
    column = 0
    i = end - 1
  }
  return out
}
