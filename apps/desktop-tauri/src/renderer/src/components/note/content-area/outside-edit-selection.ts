/**
 * The selection an editor keeps when an outside edit of its note applies. The core feeds the
 * file's text as a whole new body (`replace_doc_body`, as Electron's `replaceDocBody`), so every
 * block is new: y-prosemirror's relative positions all point into deleted blocks, and its restored
 * selection lands at the end of the note. Here the two documents are compared instead, block ids
 * aside (each block gets a new one), and the selection is mapped through the one range that
 * differs: before it the caret stays, after it the caret moves by the change's length, and inside
 * it, or in a block the edit removed, it goes to the nearest position after the change.
 *
 * @module note/content-area/outside-edit-selection
 */

import { Mark, type Fragment, type Node } from '@tiptap/pm/model'
import type { Selection } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'

export function selectionThroughOutsideEdit(
  selection: Selection,
  before: Node,
  after: Node
): Selection {
  const start = diffStart(before.content, after.content, 0)
  if (start === null) return selection.map(after, StepMap.empty)
  const end = diffEnd(before.content, after.content, before.content.size, after.content.size)
  if (end === null) return selection.map(after, StepMap.empty)
  let { a: endA, b: endB } = end
  // Repeated text at the change's edges counts in both directions; the range starts at `start`.
  const overlap = Math.max(0, start - Math.min(endA, endB))
  endA += overlap
  endB += overlap
  return selection.map(after, new StepMap([start, endA - start, endB - start]))
}

function sameMarkup(a: Node, b: Node): boolean {
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])
  keys.delete('id')
  for (const key of keys) {
    if (JSON.stringify(a.attrs[key]) !== JSON.stringify(b.attrs[key])) return false
  }
  return true
}

/** ProseMirror's `findDiffStart`, blind to block ids. */
function diffStart(a: Fragment, b: Fragment, pos: number): number | null {
  for (let i = 0; ; i++) {
    if (i === a.childCount || i === b.childCount) return a.childCount === b.childCount ? null : pos
    const childA = a.child(i)
    const childB = b.child(i)
    if (childA === childB) {
      pos += childA.nodeSize
      continue
    }
    if (!sameMarkup(childA, childB)) return pos
    if (childA.isText && childA.text !== childB.text) {
      const textA = childA.text ?? ''
      const textB = childB.text ?? ''
      for (let j = 0; j < textA.length && textA[j] === textB[j]; j++) pos++
      return pos
    }
    if (childA.content.size || childB.content.size) {
      const inner = diffStart(childA.content, childB.content, pos + 1)
      if (inner !== null) return inner
    }
    pos += childA.nodeSize
  }
}

/** ProseMirror's `findDiffEnd`, blind to block ids. */
function diffEnd(
  a: Fragment,
  b: Fragment,
  posA: number,
  posB: number
): { a: number; b: number } | null {
  for (let iA = a.childCount, iB = b.childCount; ;) {
    if (iA === 0 || iB === 0) return iA === iB ? null : { a: posA, b: posB }
    const childA = a.child(--iA)
    const childB = b.child(--iB)
    if (childA === childB) {
      posA -= childA.nodeSize
      posB -= childB.nodeSize
      continue
    }
    if (!sameMarkup(childA, childB)) return { a: posA, b: posB }
    if (childA.isText && childA.text !== childB.text) {
      const textA = childA.text ?? ''
      const textB = childB.text ?? ''
      const minSize = Math.min(textA.length, textB.length)
      for (let same = 0; same < minSize; same++) {
        if (textA[textA.length - same - 1] !== textB[textB.length - same - 1]) break
        posA--
        posB--
      }
      return { a: posA, b: posB }
    }
    if (childA.content.size || childB.content.size) {
      const inner = diffEnd(childA.content, childB.content, posA - 1, posB - 1)
      if (inner) return inner
    }
    posA -= childA.nodeSize
    posB -= childB.nodeSize
  }
}
