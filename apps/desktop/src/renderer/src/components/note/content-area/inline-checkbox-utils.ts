/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turning `| [ ] task |` on disk back into a real checkbox, on open.
 *
 * The two directions of this node are deliberately not symmetric. Writing is
 * main's and exact: the node serializes to `[ ] ` through its own DOM. Reading
 * cannot be main's, because `[ ]` in a table cell is LITERAL TEXT to every
 * markdown parser — GFM's task-list syntax is list-item only — so there is no
 * `<input>` for a `parse` rule to claim. Promotion is a normalization pass over
 * the parsed blocks instead, which is the same shape `normalizeWikiLinks` uses
 * for `[[…]]`, and for the same reason.
 *
 * Cells only. A paragraph that starts `[ ] ` is BlockNote's `checkListItem`
 * gesture and stays a checklist BLOCK; promoting there would take that away and
 * put a node in its place that reads identically and behaves worse.
 *
 * ## The conservative rule, and what it costs
 *
 * The token is claimed only at the very START of a cell, and only when it is
 * followed by a space or is the whole cell. So `[ ] task` promotes, `[x]`
 * promotes, and `see [ ] below` / `[ ]x` / `[y] task` do not.
 *
 * It is still a guess, and the false positive is real: a cell whose text
 * genuinely begins `[ ] ` — a citation style, a code snippet pasted as text —
 * becomes a checkbox that serializes back to the identical bytes. Nothing is
 * lost on disk (the round trip is byte-stable either way), but the cell now
 * renders a control the author did not ask for. Judged worth it because a cell
 * that opens with `[ ] ` and means something else is rare, and because the
 * alternative is that every hand-written or externally-edited checkbox stays
 * dead text forever.
 */

import type { Block } from '@blocknote/core'
import { createInlineCheckboxContent } from '@memry/editor-schema/inline'

/** `[ ]` / `[x]` / `[X]`, at the start, followed by a space or nothing else. */
const LEADING_CHECKBOX = /^\[([ xX])\](?: (.*)|)$/s

interface Promoted {
  checked: boolean
  rest: string
}

/**
 * The token at the head of a cell's text, and what is left after it.
 *
 * The single space that separates the box from the label is CONSUMED, not kept:
 * the node re-emits one of its own on the way out, and keeping both would add a
 * space to the cell on every save.
 */
export function matchLeadingCheckbox(text: string): Promoted | null {
  const match = LEADING_CHECKBOX.exec(text)
  if (!match) return null
  return { checked: match[1].toLowerCase() === 'x', rest: match[2] ?? '' }
}

/** Promotes the leading token of one cell's inline content, if it has one. */
function promoteCellContent(content: any): { content: any; didChange: boolean } {
  if (typeof content === 'string') {
    const promoted = matchLeadingCheckbox(content)
    if (!promoted) return { content, didChange: false }
    return {
      content: promoted.rest
        ? [
            createInlineCheckboxContent(promoted.checked),
            { type: 'text', text: promoted.rest, styles: {} }
          ]
        : [createInlineCheckboxContent(promoted.checked)],
      didChange: true
    }
  }

  if (!Array.isArray(content) || content.length === 0) return { content, didChange: false }

  // The FIRST item only. A checkbox is the head of the cell or it is nothing —
  // and anything before it (a link, a styled run) means the cell already says
  // something the token is part of rather than a marker for.
  const first = content[0]
  const text = typeof first === 'string' ? first : first?.type === 'text' ? first.text : null
  if (typeof text !== 'string') return { content, didChange: false }

  const promoted = matchLeadingCheckbox(text)
  if (!promoted) return { content, didChange: false }

  // Styles ride on with the remaining text so a cell whose label is bold keeps
  // it. The box itself has no styles field — custom inline content never does.
  const styles = typeof first === 'string' ? {} : (first.styles ?? {})
  const head: any[] = [createInlineCheckboxContent(promoted.checked)]
  if (promoted.rest) head.push({ type: 'text', text: promoted.rest, styles })

  return { content: [...head, ...content.slice(1)], didChange: true }
}

/**
 * Walks table cells only. Both cell shapes, exactly as `normalizeTableContent`
 * in wiki-link-utils.ts handles them: a bare inline-content array, and the
 * `{ type: 'tableCell', content }` object BlockNote writes once a cell carries
 * props (a background colour, an alignment).
 */
function promoteTableContent(tableContent: any): { content: any; didChange: boolean } {
  if (!tableContent?.rows) return { content: tableContent, didChange: false }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const promoted = promoteCellContent(cell)
        if (promoted.didChange) rowChanged = true
        return promoted.content
      }

      if (cell?.type === 'tableCell' || cell?.type === 'tableHeader') {
        const promoted = promoteCellContent(cell.content ?? '')
        if (promoted.didChange) {
          rowChanged = true
          return { ...cell, content: promoted.content }
        }
      }

      return cell
    })

    if (rowChanged) {
      didChange = true
      return { ...row, cells }
    }
    return row
  })

  return didChange
    ? { content: { ...tableContent, rows }, didChange }
    : { content: tableContent, didChange: false }
}

/** A table anywhere in this block's subtree — the only thing this pass reads. */
function hasTable(block: Block): boolean {
  if (block.type === 'table') return true
  return (block.children as Block[] | undefined)?.some(hasTable) ?? false
}

export function normalizeInlineCheckboxes(blocks: Block[]): {
  blocks: Block[]
  didChange: boolean
} {
  // This runs on every note open, so it bails before walking anything. NOT the
  // `JSON.stringify(blocks).includes(...)` sniff `normalizeWikiLinks` uses:
  // `JSON.stringify` of an array always starts with `[`, so the same guard
  // spelled with `'['` is dead code that never bails. The precise test is
  // cheaper anyway — this pass only ever touches tables.
  if (!blocks.some(hasTable)) return { blocks, didChange: false }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    let blockChanged = false
    let nextBlock: Block = block

    const content = block.content as any
    if (content && !Array.isArray(content) && content.type === 'tableContent') {
      const promoted = promoteTableContent(content)
      if (promoted.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, content: promoted.content }
      }
    }

    if (block.children?.length) {
      const promotedChildren = normalizeInlineCheckboxes(block.children as Block[])
      if (promotedChildren.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, children: promotedChildren.blocks }
      }
    }

    if (blockChanged) didChange = true
    return blockChanged ? nextBlock : block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
