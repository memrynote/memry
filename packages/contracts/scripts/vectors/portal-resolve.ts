/**
 * Class: portal resolution (`portal-resolve.json`).
 *
 * A portal definition (format v1) plus the source note's flat block list in,
 * the blocks it shows and the ones it hides out. The reference is `@memry/shared/portal-resolve`; Rust's
 * `portal` module is the other port. Only `ok` and `missing-block` come out of
 * this function; the caller decides `missing-note`, `locked`, `cycle`,
 * `too-deep` and `not-synced` before it has a block list.
 *
 * Input block shape (a subset of `extract-blocks`'s `Block`, which Rust's
 * `Notes.blocks` also returns; extra fields are ignored):
 *   { id: string, kind: string, depth: number, inline: [{ text: string }] }
 * Block text is the concatenation of `inline[].text`. `expectedIds` lists the
 * `id` of every shown block, in order; `expectedHiddenSiblings` the ids of the
 * hidden same-parent siblings of the roots, in order; `expectedHiddenChildren`
 * maps the anchor of a shown block to the ids of its hidden children.
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
    name: 'collapsed-root',
    pins: 'a root absent from open is collapsed: only the root shows, its children are hidden',
    definition: '{"v":1,"note":"n1","blocks":["par1"]}',
    blocks: TREE
  },
  {
    name: 'whole-note',
    pins: 'a note target (no blocks) shows every block with nothing hidden',
    definition: '{"v":1,"note":"n1"}',
    blocks: TREE
  },
  {
    name: 'v-absent-is-v1',
    pins: 'an absent v reads as 1',
    definition: '{"note":"n1","blocks":["par1"]}',
    blocks: TREE
  },
  {
    name: 'multi-root',
    pins: 'several roots show in document order, each collapsed',
    definition: '{"v":1,"note":"n1","blocks":["sib1","ch02"]}',
    blocks: TREE
  },
  {
    name: 'multi-root-missing-one',
    pins: 'a root that matches no block is ignored while another matches',
    definition: '{"v":1,"note":"n1","blocks":["nope1","sib1"]}',
    blocks: TREE
  },
  {
    name: 'show-mode',
    pins: 'show-mode lists the only children that show',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"show":["ch02"]}}}',
    blocks: TREE
  },
  {
    name: 'hide-mode',
    pins: 'hide-mode shows every child except the listed ones, and a hidden child takes its subtree with it',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"hide":["ch01"]}}}',
    blocks: TREE
  },
  {
    name: 'hide-mode-empty',
    pins: 'hide-mode with an empty list shows all children; their own children stay collapsed',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"hide":[]}}}',
    blocks: TREE
  },
  {
    name: 'nested-open',
    pins: 'a grandchild shows when its parent is visible and open',
    definition:
      '{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"hide":[]},"ch01":{"hide":[]}}}',
    blocks: TREE
  },
  {
    name: 'open-under-collapsed-parent',
    pins: 'an open entry does not show anything below a collapsed parent',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"open":{"ch01":{"hide":[]}}}',
    blocks: TREE
  },
  {
    name: 'include-parent',
    pins: 'the include-parent shape: the parent is the root and the old root its only shown child',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"open":{"par1":{"show":["ch01"]}}}',
    blocks: TREE
  },
  {
    name: 'nested-root',
    pins: 'a nested block is a root too; its siblings are hidden siblings',
    definition: '{"v":1,"note":"n1","blocks":["ch01"]}',
    blocks: TREE
  },
  {
    name: 'root-sibling-appended',
    pins: 'a sibling made through the portal is appended to blocks and shows next to the root',
    definition: '{"v":1,"note":"n1","blocks":["par1","sib1"]}',
    blocks: TREE
  },
  {
    name: 'unknown-keys-preserved',
    pins: 'keys this build does not know do not change resolution',
    definition: '{"v":1,"note":"n1","blocks":["par1"],"layout":{"future":true}}',
    blocks: TREE
  },
  {
    name: 'missing-anchor',
    pins: 'no block ends with any root anchor: missing-block, no blocks',
    definition: '{"v":1,"note":"n1","blocks":["nope1"]}',
    blocks: TREE
  },
  {
    name: 'anchor-mid-line-not-matched',
    pins: 'an anchor-like token that is not at the end of the text is not an anchor',
    definition: '{"v":1,"note":"n1","blocks":["mid1"]}',
    blocks: [blk('m0', 0, 'see ^mid1 for more'), blk('m1', 0, 'Other')]
  },
  {
    name: 'caret-inside-word-not-matched',
    pins: 'a caret glued to a word is not an anchor',
    definition: '{"v":1,"note":"n1","blocks":["glue1"]}',
    blocks: [blk('g0', 0, 'x^glue1')]
  },
  {
    name: 'duplicate-anchors-first-wins',
    pins: 'when two blocks end with the same anchor the first in document order is the root',
    definition: '{"v":1,"note":"n1","blocks":["dup1"]}',
    blocks: [blk('d0', 0, 'First ^dup1'), blk('d1', 1, 'Under first'), blk('d2', 0, 'Second ^dup1')]
  },
  {
    name: 'anchor-across-inline-runs',
    pins: 'block text is the runs joined, so a marked run before the anchor still matches',
    definition: '{"v":1,"note":"n1","blocks":["run01"]}',
    blocks: [blk('r0', 0, 'Bold part', ' tail ^run', '01'), blk('r1', 1, 'child')]
  },
  {
    name: 'search-is-invalid',
    pins: 'a search target is resolved by the caller: invalid here, no blocks',
    definition: '{"v":1,"search":{"text":"exam","limit":50}}',
    blocks: TREE
  },
  {
    name: 'empty-note-whole',
    pins: 'a note target over a note with no blocks resolves ok and empty',
    definition: '{"v":1,"note":"n1"}',
    blocks: []
  }
]

export function buildPortalResolve(): unknown {
  const cases = CASES.map((c) => {
    const parsed = parsePortalDefinition(c.definition)
    if (!parsed.ok) throw new Error(`portal-resolve case ${c.name}: definition does not parse`)
    const result = resolvePortal(c.blocks, parsed.definition.target)
    return {
      name: c.name,
      pins: c.pins,
      definition: c.definition,
      blocks: c.blocks,
      expectedStatus: result.status,
      expectedIds: result.blocks.map((b) => b.id),
      expectedHiddenSiblings: result.hidden.siblings.map((b) => b.id),
      expectedHiddenChildren: Object.fromEntries(
        Object.entries(result.hidden.children).map(([anchor, hidden]) => [
          anchor,
          hidden.map((b) => b.id)
        ])
      )
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
