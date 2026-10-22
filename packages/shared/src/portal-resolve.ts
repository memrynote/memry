/**
 * Reference resolver for a portal's note and block targets.
 *
 * Given a definition and the source note's flat block list (the shape
 * `extract-blocks` produces and Rust's `Notes.blocks` returns), it returns the
 * blocks the portal shows. Pure, no I/O. `crates/memry-core` carries the other
 * port, and `portal-resolve.json` holds the two together.
 *
 * Scope: this answers `ok` or `missing-block` only. Whether the note exists
 * (`missing-note`), is encrypted (`locked`), has synced yet (`not-synced`),
 * would contain itself (`cycle`) or sits too deep (`too-deep`) is the caller's
 * to decide before it gets a block list, because those depend on state this
 * function never sees. Search portals are computed by the caller too.
 *
 * Window rules:
 *  - a note target shows every block except the hidden ones;
 *  - a block target shows the first block, in document order, whose text ends
 *    with ` ^anchor`, plus the blocks after it that are deeper than it, up to
 *    the next block at its depth or shallower;
 *  - a `hidden` anchor drops the block carrying it and that block's own
 *    descendants. In a block target the root can never be hidden; a hidden
 *    entry matching it is ignored. A hidden anchor matching nothing is
 *    ignored.
 */
import { extractAnchor, type PortalDefinition } from './portal-block'

/** The part of a block this resolver reads. `extract-blocks`'s `Block` satisfies it. */
export interface PortalSourceBlock {
  depth: number
  inline: ReadonlyArray<{ text: string }>
}

export type PortalResolution<B extends PortalSourceBlock> =
  { status: 'ok'; blocks: B[] } | { status: 'missing-block'; blocks: [] }

/** A block's plain text: its inline runs, concatenated. */
export function portalBlockText(block: PortalSourceBlock): string {
  return block.inline.map((run) => run.text).join('')
}

/**
 * The blocks of `sourceBlocks[from..end)` with every hidden anchor's subtree
 * dropped. `end` is exclusive.
 */
function visibleBlocks<B extends PortalSourceBlock>(
  sourceBlocks: readonly B[],
  from: number,
  end: number,
  hidden: ReadonlySet<string>
): B[] {
  const blocks: B[] = []
  // Depth of the hidden block whose subtree is being skipped, or null.
  let skipBelow: number | null = null
  for (let i = from; i < end; i += 1) {
    const block = sourceBlocks[i]
    if (skipBelow !== null) {
      if (block.depth > skipBelow) continue
      skipBelow = null
    }
    const anchor = extractAnchor(portalBlockText(block))
    if (anchor !== null && hidden.has(anchor)) {
      skipBelow = block.depth
      continue
    }
    blocks.push(block)
  }
  return blocks
}

export function resolvePortal<B extends PortalSourceBlock>(
  definition: PortalDefinition,
  sourceBlocks: readonly B[]
): PortalResolution<B> {
  const { target } = definition
  const hidden = new Set(definition.hidden)
  if (target.kind === 'search') return { status: 'missing-block', blocks: [] }
  if (target.kind === 'note') {
    return { status: 'ok', blocks: visibleBlocks(sourceBlocks, 0, sourceBlocks.length, hidden) }
  }

  const rootIndex = sourceBlocks.findIndex(
    (block) => extractAnchor(portalBlockText(block)) === target.block
  )
  if (rootIndex < 0) return { status: 'missing-block', blocks: [] }

  const root = sourceBlocks[rootIndex]
  let end = rootIndex + 1
  while (end < sourceBlocks.length && sourceBlocks[end].depth > root.depth) end += 1
  return {
    status: 'ok',
    blocks: [root, ...visibleBlocks(sourceBlocks, rootIndex + 1, end, hidden)]
  }
}
