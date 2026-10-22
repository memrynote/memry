/**
 * Class: portal resolution (`portal-resolve.json`).
 *
 * A portal definition plus the source note's flat block list in, the blocks it
 * shows out. The reference is `@memry/shared/portal-resolve`; Rust's
 * `portal` module is the other port. Only `ok` and `missing-block` come out of
 * this function; the caller decides `missing-note`, `locked`, `cycle`,
 * `too-deep` and `not-synced` before it has a block list.
 *
 * Input block shape (a subset of `extract-blocks`'s `Block`, which Rust's
 * `Notes.blocks` also returns; extra fields are ignored):
 *   { id: string, kind: string, depth: number, inline: [{ text: string }] }
 * Block text is the concatenation of `inline[].text`. `expectedIds` lists the
 * `id` of every returned block, in order.
 *
 * Chapter: docs/protocol/12-note-body-format.md §12.6.3.
 */
import { parsePortalDefinition } from '@memry/shared/portal-block'
import { resolvePortal } from '@memry/shared/portal-resolve'
import { meta } from './shared'

interface VectorBlock {
  id: string
  kind: string
  depth: number
  inline: Array<{ text: string }>
}

const blk = (id: string, depth: number, ...runs: string[]): VectorBlock => ({
  id,
  kind: 'paragraph',
  depth,
  inline: runs.map((text) => ({ text }))
})

const TREE: VectorBlock[] = [
  blk('b0', 0, 'Intro'),
  blk('b1', 0, 'Parent ^par1'),
  blk('b2', 1, 'Child one ^ch01'),
  blk('b3', 2, 'Grandchild of one ^gc01'),
  blk('b4', 2, 'Grandchild plain'),
  blk('b5', 1, 'Child two ^ch02'),
  blk('b6', 0, 'Sibling after')
]

const CASES: Array<{
  name: string
  pins: string
  definition: string
  blocks: VectorBlock[]
}> = [
  {
    name: 'whole-note',
    pins: 'a note target with nothing hidden shows every block',
    definition: '{"note":"n1"}',
    blocks: TREE
  },
  {
    name: 'whole-note-hidden-subtree',
    pins: 'a note target drops a hidden block and its descendants',
    definition: '{"note":"n1","hidden":["ch01"]}',
    blocks: TREE
  },
  {
    name: 'whole-note-hidden-top-level',
    pins: 'a note target may hide a top-level block: no root exemption outside a block target',
    definition: '{"note":"n1","hidden":["par1"]}',
    blocks: TREE
  },
  {
    name: 'block-with-children',
    pins: 'a block target shows the block and every deeper block up to the next sibling',
    definition: '{"note":"n1","block":"par1"}',
    blocks: TREE
  },
  {
    name: 'block-leaf',
    pins: 'a block with no deeper block after it is shown alone',
    definition: '{"note":"n1","block":"ch02"}',
    blocks: TREE
  },
  {
    name: 'block-nested-depth',
    pins: 'a nested block is a root too; its window ends at the next block at its depth or less',
    definition: '{"note":"n1","block":"ch01"}',
    blocks: TREE
  },
  {
    name: 'hidden-child',
    pins: 'a hidden anchor drops that block and its own descendants, not its siblings',
    definition: '{"note":"n1","block":"par1","hidden":["ch01"]}',
    blocks: TREE
  },
  {
    name: 'hidden-grandchild',
    pins: 'hiding a deep block leaves its parent and siblings',
    definition: '{"note":"n1","block":"par1","hidden":["gc01"]}',
    blocks: TREE
  },
  {
    name: 'hidden-root-ignored',
    pins: 'the root cannot be hidden: a hidden entry naming it is ignored',
    definition: '{"note":"n1","block":"par1","hidden":["par1"]}',
    blocks: TREE
  },
  {
    name: 'hidden-unknown-ignored',
    pins: 'a hidden anchor that matches nothing changes nothing',
    definition: '{"note":"n1","block":"par1","hidden":["zzzz9"]}',
    blocks: TREE
  },
  {
    name: 'missing-anchor',
    pins: 'no block ends with the anchor: missing-block, no blocks',
    definition: '{"note":"n1","block":"nope1"}',
    blocks: TREE
  },
  {
    name: 'anchor-mid-line-not-matched',
    pins: 'an anchor-like token that is not at the end of the text is not an anchor',
    definition: '{"note":"n1","block":"mid1"}',
    blocks: [blk('m0', 0, 'see ^mid1 for more'), blk('m1', 0, 'Other')]
  },
  {
    name: 'caret-inside-word-not-matched',
    pins: 'a caret glued to a word is not an anchor',
    definition: '{"note":"n1","block":"glue1"}',
    blocks: [blk('g0', 0, 'x^glue1')]
  },
  {
    name: 'duplicate-anchors-first-wins',
    pins: 'when two blocks end with the same anchor the first in document order is the root',
    definition: '{"note":"n1","block":"dup1"}',
    blocks: [blk('d0', 0, 'First ^dup1'), blk('d1', 1, 'Under first'), blk('d2', 0, 'Second ^dup1')]
  },
  {
    name: 'anchor-across-inline-runs',
    pins: 'block text is the runs joined, so a marked run before the anchor still matches',
    definition: '{"note":"n1","block":"run01"}',
    blocks: [blk('r0', 0, 'Bold part', ' tail ^run', '01'), blk('r1', 1, 'child')]
  },
  {
    name: 'empty-note-whole',
    pins: 'a note target over a note with no blocks resolves ok and empty',
    definition: '{"note":"n1"}',
    blocks: []
  }
]

export function buildPortalResolve(): unknown {
  const cases = CASES.map((c) => {
    const parsed = parsePortalDefinition(c.definition)
    if (!parsed.ok) throw new Error(`portal-resolve case ${c.name}: definition does not parse`)
    const result = resolvePortal(parsed.definition, c.blocks)
    return {
      name: c.name,
      pins: c.pins,
      definition: c.definition,
      blocks: c.blocks,
      expectedStatus: result.status,
      expectedIds: result.blocks.map((b) => b.id)
    }
  })
  return {
    meta: meta({
      class: 'portal-resolve',
      caseCount: cases.length,
      chapter: 'docs/protocol/12-note-body-format.md §12.6.3'
    }),
    cases
  }
}
