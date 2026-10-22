/**
 * Reference resolver for a portal's note and blocks targets (format v1).
 *
 * Given a target and the source note's flat block list (the shape
 * `extract-blocks` produces and Rust's `Notes.blocks` returns), it returns the
 * blocks the portal shows and the blocks it hides. Pure, no I/O.
 * `crates/memry-core` carries the other port, and `portal-resolve.json` holds
 * the two together.
 *
 * Scope: this answers `ok`, `missing-block` or `invalid` only. Whether the
 * note exists (`missing-note`), is encrypted (`locked`), has synced yet
 * (`not-synced`), would contain itself (`cycle`) or sits too deep (`too-deep`)
 * is the caller's to decide before it gets a block list. Search portals are
 * computed by the caller too, so they resolve `invalid` here.
 *
 * Visibility rule: a block is visible iff it is a root, or its parent is
 * visible, its parent is in `open`, and (hide-mode) the block is not listed or
 * (show-mode) the block is listed. A block's parent is the nearest earlier
 * block that is shallower. Visible blocks keep the source's document order. A
 * note target shows every block. Roots whose anchor matches no block are
 * ignored; `missing-block` means none of them matched. When two blocks carry
 * the same anchor the first in document order owns it.
 */
import { extractAnchor, type PortalTarget } from './portal-block'

/** The part of a block this resolver reads. `extract-blocks`'s `Block` satisfies it. */
export interface ResolverBlock {
  depth: number
  inline: ReadonlyArray<{ text: string }>
}

export interface PortalResolution<B extends ResolverBlock> {
  status: 'ok' | 'missing-block' | 'invalid'
  /** The visible blocks, in document order. */
  blocks: B[]
  hidden: {
    /** Same-parent siblings of the roots that are not shown, in document order. */
    siblings: B[]
    /** Children of a visible block that are not shown, keyed by that block's anchor. */
    children: Record<string, B[]>
  }
}

/** A block's plain text: its inline runs, concatenated. */
export function portalBlockText(block: ResolverBlock): string {
  return block.inline.map((run) => run.text).join('')
}

function empty<B extends ResolverBlock>(
  status: PortalResolution<B>['status']
): PortalResolution<B> {
  return { status, blocks: [], hidden: { siblings: [], children: {} } }
}

export function resolvePortal<B extends ResolverBlock>(
  blocks: readonly B[],
  target: PortalTarget
): PortalResolution<B> {
  if (target.kind === 'search') return empty('invalid')
  if (target.kind === 'note') {
    return { status: 'ok', blocks: [...blocks], hidden: { siblings: [], children: {} } }
  }

  // The anchor each block owns; a repeat of an earlier anchor owns nothing.
  const anchors: Array<string | null> = []
  const indexOfAnchor = new Map<string, number>()
  blocks.forEach((block, i) => {
    const anchor = extractAnchor(portalBlockText(block))
    if (anchor !== null && !indexOfAnchor.has(anchor)) {
      indexOfAnchor.set(anchor, i)
      anchors.push(anchor)
    } else {
      anchors.push(null)
    }
  })

  const rootIndexes = new Set<number>()
  for (const anchor of target.blocks) {
    const at = indexOfAnchor.get(anchor)
    if (at !== undefined) rootIndexes.add(at)
  }
  if (rootIndexes.size === 0) return empty('missing-block')

  // Parent of each block: the nearest earlier block that is shallower, else -1.
  const parents: number[] = []
  const stack: number[] = []
  blocks.forEach((block, i) => {
    while (stack.length > 0 && blocks[stack[stack.length - 1]].depth >= block.depth) stack.pop()
    parents.push(stack.length > 0 ? stack[stack.length - 1] : -1)
    stack.push(i)
  })

  const visible: boolean[] = []
  blocks.forEach((_block, i) => {
    const p = parents[i]
    let shown = rootIndexes.has(i)
    if (!shown && p >= 0 && visible[p]) {
      const parentAnchor = anchors[p]
      const open = parentAnchor === null ? undefined : target.open[parentAnchor]
      const own = anchors[i]
      if (open) {
        const listed = own !== null && open.ids.includes(own)
        shown = open.mode === 'hide' ? !listed : listed
      }
    }
    visible.push(shown)
  })

  const rootParents = new Set([...rootIndexes].map((i) => parents[i]))
  const result = empty<B>('ok')
  blocks.forEach((block, i) => {
    if (visible[i]) {
      result.blocks.push(block)
      return
    }
    if (rootParents.has(parents[i])) result.hidden.siblings.push(block)
    const p = parents[i]
    const parentAnchor = p >= 0 && visible[p] ? anchors[p] : null
    if (parentAnchor !== null) (result.hidden.children[parentAnchor] ??= []).push(block)
  })
  return result
}
