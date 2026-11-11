/**
 * The selection an editor keeps when an outside edit of its note applies. The core feeds the
 * file's text as a whole new body (`replace_doc_body`, as Electron's `replaceDocBody`), so every
 * block is new: y-prosemirror's relative positions all point into deleted blocks, and its restored
 * selection lands at the end of the note. Here the two documents are compared instead, block ids
 * aside (each block gets a new one). Their top-level blocks are aligned by content (common prefix
 * and suffix, then a block diff of the middle), and each run of changed blocks gives one changed
 * range. The selection is mapped through those ranges: a caret outside every range stays in its
 * text, moved by the length changes before it, so an edit at the top and one at the bottom leave a
 * caret between them in place. A block whose type or attrs changed (a paragraph made a heading, a
 * heading's level) is compared by its text, so its caret stays too. Inside a range, or in a block
 * the edit removed, the caret goes to the nearest position after the change.
 *
 * @module note/content-area/outside-edit-selection
 */

import { Fragment, Mark, type Node } from '@tiptap/pm/model'
import type { Selection } from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'

/**
 * Past this many inserted or removed blocks the block diff stops, and the middle's blocks whose
 * content is unique on both sides match instead: the diff costs (blocks x edits) steps, and its
 * trace edits squared. 3,000 blocks map in about 10 ms either way.
 */
const MAX_BLOCK_EDITS = 1000

export function selectionThroughOutsideEdit(
  selection: Selection,
  before: Node,
  after: Node
): Selection {
  return selection.map(after, outsideEditMap(before, after))
}

/** The map of positions from `before` to `after`, through the ranges the edit changed. */
export function outsideEditMap(before: Node, after: Node): StepMap {
  return new StepMap(changedRanges(before, after))
}

/** The StepMap ranges (`[start, oldSize, newSize]`, in `before`'s positions) of the edit. */
function changedRanges(before: Node, after: Node): number[] {
  // Down to the level of the blocks: the wrappers (`doc`, its `blockGroup`) the two share.
  let a = before.content
  let b = after.content
  let base = 0
  while (
    a.childCount === 1 &&
    b.childCount === 1 &&
    !a.child(0).isTextblock &&
    sameMarkup(a.child(0), b.child(0))
  ) {
    a = a.child(0).content
    b = b.child(0).content
    base++
  }
  const ids = new Map<string, number>()
  const keysA = blockKeys(a, ids)
  const keysB = blockKeys(b, ids)
  const posA = offsets(a, base)
  const posB = offsets(b, base)
  const ranges: number[] = []
  const alike = (i: number, j: number): boolean => similarText(a.child(i), b.child(j))
  for (const [fromA, toA, fromB, toB] of blockRuns(keysA, keysB, alike)) {
    const childrenA = Array.from({ length: toA - fromA }, (_, i) => a.child(fromA + i))
    const childrenB = Array.from({ length: toB - fromB }, (_, i) => b.child(fromB + i))
    const runA = Fragment.from(childrenA)
    const runB = Fragment.from(childrenB)
    const start = diffStart(runA, runB, posA[fromA])
    const end = diffEnd(runA, runB, posA[toA], posB[toB])
    if (start === null || end === null) continue
    // `start` is in both documents' positions up to the run; `shift` turns it into `after`'s.
    const shift = posB[fromB] - posA[fromA]
    // Repeated text at the change's edges counts in both directions; the range starts at `start`.
    const overlap = Math.max(0, start - Math.min(end.a, end.b - shift))
    ranges.push(start, end.a + overlap - start, end.b + overlap - shift - start)
  }
  return ranges
}

/** Each block's content, ids aside, as a number: equal blocks get equal numbers. */
function blockKeys(blocks: Fragment, ids: Map<string, number>): number[] {
  const keys: number[] = []
  blocks.forEach((block) => {
    const json = JSON.stringify(withoutIds(block.toJSON()))
    let id = ids.get(json)
    if (id === undefined) {
      id = ids.size
      ids.set(json, id)
    }
    keys.push(id)
  })
  return keys
}

type NodeJson = { attrs?: Record<string, unknown>; content?: NodeJson[] }

/** A copy of `json` without block ids: `Node.toJSON` shares `attrs` with the live node. */
function withoutIds({ attrs, content, ...rest }: NodeJson): NodeJson {
  const { id: _id, ...kept } = attrs ?? {}
  return { ...rest, attrs: kept, content: content?.map(withoutIds) }
}

/** The position before each block, and after the last one. */
function offsets(blocks: Fragment, base: number): number[] {
  const pos = [base]
  blocks.forEach((block) => pos.push(pos[pos.length - 1] + block.nodeSize))
  return pos
}

type Run = [fromA: number, toA: number, fromB: number, toB: number]

/**
 * The runs of blocks that differ (end exclusive): the blocks of the common prefix and suffix match,
 * and Myers' diff matches those of the middle. `alike(i, j)` says whether `a[i]` and `b[j]` look
 * like one block edited.
 */
function blockRuns(a: number[], b: number[], alike: (i: number, j: number) => boolean): Run[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const endA = a.length - tail
  const endB = b.length - tail
  if (head === endA && head === endB) return []
  const runs: Run[] = []
  const middleA = a.slice(head, endA)
  const middleB = b.slice(head, endB)
  const matches = middleMatches(middleA, middleB) ?? uniqueMatches(middleA, middleB)
  let i = head
  let j = head
  for (const [mi, mj] of [...matches.map(([x, y]) => [head + x, head + y]), [endA, endB]]) {
    runs.push(...gapRuns(a, b, [i, mi, j, mj], alike))
    i = mi + 1
    j = mj + 1
  }
  return runs
}

/**
 * The runs of one gap between matched blocks. Its blocks pair one to one, each pair its own run, so
 * a caret keeps its place in a block whose other text changed: all of them when both sides have as
 * many (one paragraph reworded, every line reformatted), else those at the gap's edges that look
 * `alike` (a block edited beside one inserted or removed). The rest is one run.
 */
function gapRuns(
  a: number[],
  b: number[],
  [i, toA, j, toB]: Run,
  alike: (i: number, j: number) => boolean
): Run[] {
  const head: Run[] = []
  const tail: Run[] = []
  const changed = (x: number, y: number): boolean => a[x] !== b[y]
  while (i < toA && j < toB && (toA - i === toB - j || alike(i, j))) {
    if (changed(i, j)) head.push([i, i + 1, j, j + 1])
    i++
    j++
  }
  while (i < toA && j < toB && alike(toA - 1, toB - 1)) {
    toA--
    toB--
    if (changed(toA, toB)) tail.push([toA, toA + 1, toB, toB + 1])
  }
  if (i < toA || j < toB) head.push([i, toA, j, toB])
  return [...head, ...tail.toReversed()]
}

/**
 * The index pairs, in order, of the blocks whose content occurs once in `a` and once in `b`, those
 * that would cross an earlier pair left out. Linear: the match past the diff's edit cap, so a caret
 * in a block the edit kept stays in it however many blocks moved around it.
 */
function uniqueMatches(a: number[], b: number[]): Array<[number, number]> {
  const countsA = keyCounts(a)
  const countsB = keyCounts(b)
  const indexB = new Map<number, number>()
  b.forEach((key, j) => {
    if (countsB.get(key) === 1) indexB.set(key, j)
  })
  const matches: Array<[number, number]> = []
  let last = -1
  a.forEach((key, i) => {
    const j = indexB.get(key)
    if (j === undefined || countsA.get(key) !== 1 || j <= last) return
    matches.push([i, j])
    last = j
  })
  return matches
}

function keyCounts(keys: number[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

/** Whether two blocks share, at their start and end, at least half the text of the longer one. */
function similarText(x: Node, y: Node): boolean {
  const s = x.textContent
  const t = y.textContent
  let same = 0
  while (same < s.length && same < t.length && s[same] === t[same]) same++
  for (
    let end = 1;
    same < s.length && same < t.length && s[s.length - end] === t[t.length - end];
    end++
  ) {
    same++
  }
  return 2 * same >= Math.max(s.length, t.length)
}

/**
 * The matched index pairs of a shortest edit script from `a` to `b` (Myers 1986), in order, or
 * null past `MAX_BLOCK_EDITS` edits. `trace[d]` holds the furthest x of each diagonal k in
 * -d..d after round d.
 */
function middleMatches(a: number[], b: number[]): Array<[number, number]> | null {
  const n = a.length
  const m = b.length
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= Math.min(n + m, MAX_BLOCK_EDITS) && found < 0; d++) {
    const prev = trace[d - 1]
    const row = new Int32Array(2 * d + 1)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (d === 0) x = 0
      else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) {
        x = prev[k + 1 + d - 1]
      } else x = prev[k - 1 + d - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      row[k + d] = x
      if (x >= n && y >= m) found = d
    }
    trace.push(row)
  }
  if (found < 0) return null
  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]
    const k = x - y
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])
    const prevK = down ? k + 1 : k - 1
    const prevX = prev[prevK + d - 1]
    const snakeX = down ? prevX : prevX + 1
    while (x > snakeX) matches.push([--x, --y])
    x = prevX
    y = prevX - prevK
  }
  while (x > 0) matches.push([--x, --y])
  return matches.toReversed()
}

/** Whether the diff goes on inside two differing nodes: same markup, or two textblocks. */
function comparable(a: Node, b: Node): boolean {
  return sameMarkup(a, b) || (a.isTextblock && b.isTextblock)
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
    if (!comparable(childA, childB)) return pos
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
    if (!comparable(childA, childB)) return { a: posA, b: posB }
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
