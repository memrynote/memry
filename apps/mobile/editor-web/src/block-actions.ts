/**
 * Colour, Duplicate and Delete against one named block (#2100).
 *
 * The imperative half of the block menu, over a narrow surface — the same
 * shape `block-styles.ts` takes, and for the same reason: `main.ts` mounts the
 * bridge at import time, so nothing in it can be asserted against a real
 * `BlockNoteEditor`. Everything here can.
 *
 * Every function names its block by id. There is no signature in this module
 * that means "the current block", because the panel is opened from a long-press
 * as often as from the caret and the two disagree.
 */

import type { BlockAction } from './block-capabilities.ts'

/** The narrow slice of a block these actions pass back to the editor. */
export interface ActionBlockLike {
  id: string
  type: string
  props: object
}

/** The narrow slice of the editor these actions need. */
export interface BlockActionEditorSurface {
  getBlock(id: string): ActionBlockLike | undefined
  insertBlocks(blocks: unknown[], at: ActionBlockLike, place: 'after'): unknown
  removeBlocks(blocks: ActionBlockLike[]): unknown
  updateBlock(block: ActionBlockLike, update: { props: Record<string, string> }): unknown
}

/** `gone` means the block left the document — a pull, an undo, a second tap. */
export type BlockActionOutcome =
  { status: 'applied'; keepOpen: boolean } | { status: 'requested-move' } | { status: 'gone' }

/** Desktop's `stripIds`: fresh ids for the copy AND every descendant. */
export function stripBlockIds<T>(block: T): T {
  const node = block as { children?: unknown }
  return {
    ...(block as object),
    id: undefined,
    children: Array.isArray(node.children) ? node.children.map(stripBlockIds) : node.children
  } as T
}

/**
 * Colour / Duplicate / Delete, applied locally.
 *
 * `move` is NOT handled here: it is the one action whose effect is not local,
 * so it returns `requested-move` and `block-menu.ts` owns the round trip.
 */
export function runBlockAction(
  editor: BlockActionEditorSurface,
  blockId: string,
  action: BlockAction
): BlockActionOutcome {
  const block = editor.getBlock(blockId)
  // Checked before the switch, `move` included: asking the host to move a block
  // that has already left the note would answer with a delete of nothing and a
  // toast naming a block the reader can no longer see.
  if (!block) return { status: 'gone' }

  switch (action.kind) {
    case 'colour':
      // `default` is written EXPLICITLY, unlike the inline path in
      // `runStyleAction` which REMOVES the style. A block prop's default value
      // IS the string `default`, and BlockNote omits default-valued props when
      // it serializes, so the write is the reset — the same thing desktop's
      // `BlockColorsItem` does.
      editor.updateBlock(block, {
        props: { [action.slot === 'text' ? 'textColor' : 'backgroundColor']: action.colour }
      })
      // A nudge-and-look loop, like the style panel: the panel stays up and
      // re-renders with the colour the block now carries.
      return { status: 'applied', keepOpen: true }
    case 'duplicate':
      editor.insertBlocks([stripBlockIds(block)], block, 'after')
      return { status: 'applied', keepOpen: false }
    case 'delete':
      editor.removeBlocks([block])
      return { status: 'applied', keepOpen: false }
    case 'move':
      return { status: 'requested-move' }
    default: {
      const _exhaustive: never = action
      void _exhaustive
      throw new Error('unreachable')
    }
  }
}
