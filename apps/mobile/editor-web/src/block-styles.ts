/**
 * Alignment, colour and nesting on a touch surface (#2102).
 *
 * Everything here goes through props and styles that already exist: desktop's
 * `review-formatting-toolbar.tsx` reaches the same three groups through
 * BlockNote's own `TextAlignButton`, `ColorStyleButton` and
 * `NestBlockButton` / `UnnestBlockButton`, and those write `textAlignment`,
 * `textColor` / `backgroundColor`, and `nestBlock()` / `unnestBlock()`. The
 * phone writes the identical values, so a note styled here is read back by an
 * older desktop build unchanged and its markdown markers are byte-identical.
 *
 * Kept out of `main.ts` for the same reason the table transforms are
 * (`tables.ts`): that module mounts the bridge at import time, so nothing in
 * it can be asserted against a real editor.
 */

import { BLOCK_COLOURS, type BlockColour, type StyleAction } from '@memry/contracts/webview-bridge'

interface BlockLike {
  /** BlockNote identifies the block to update by id, so it travels with it. */
  id: string
  props: object
}

/** The narrow slice of the editor these helpers need, so they stay testable. */
export interface StyleEditorSurface {
  getSelection(): { blocks: readonly BlockLike[] } | undefined
  getTextCursorPosition(): { block: BlockLike }
  getActiveStyles(): Record<string, unknown>
  transact<T>(cb: () => T): T
  updateBlock(block: BlockLike, update: { props: Record<string, string> }): unknown
  addStyles(styles: Record<string, string>): void
  removeStyles(styles: Record<string, string>): void
  canNestBlock(): boolean
  nestBlock(): void
  canUnnestBlock(): boolean
  unnestBlock(): void
}

/**
 * `textAlignment` is BlockNote's own default prop, and the one desktop's
 * `TextAlignButton` writes. Reading it by presence rather than by block type
 * keeps a block that never carried it (a table, an image) out of the panel,
 * instead of writing a prop its node has no slot for.
 */
export function readAlignment(props: object): string | null {
  const value = (props as { textAlignment?: unknown }).textAlignment
  return typeof value === 'string' ? value : null
}

/**
 * The active `textColor` / `backgroundColor`, narrowed to the shared palette.
 *
 * A value outside it can only have come from an editor with a wider palette,
 * and the honest answer is then "none of these ten": the panel checks nothing
 * and leaves the style alone until the user picks one.
 */
export function readColour(value: unknown): BlockColour {
  return BLOCK_COLOURS.includes(value as BlockColour) ? (value as BlockColour) : 'default'
}

export function runStyleAction(editor: StyleEditorSurface, action: StyleAction): void {
  switch (action.kind) {
    case 'align': {
      const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]
      editor.transact(() => {
        for (const block of blocks) {
          if (readAlignment(block.props) === null) continue
          editor.updateBlock(block, { props: { textAlignment: action.alignment } })
        }
      })
      return
    }
    case 'text-colour':
      // `default` is the ABSENCE of the style, exactly as desktop's
      // `ColorStyleButton` treats it — an explicit `textColor: 'default'`
      // would serialize a colour marker for a run nobody coloured.
      if (action.colour === 'default') editor.removeStyles({ textColor: action.colour })
      else editor.addStyles({ textColor: action.colour })
      return
    case 'background-colour':
      if (action.colour === 'default') editor.removeStyles({ backgroundColor: action.colour })
      else editor.addStyles({ backgroundColor: action.colour })
      return
    case 'nest':
      // The command `Tab` already runs in the guest; there is no second path.
      if (editor.canNestBlock()) editor.nestBlock()
      return
    case 'unnest':
      if (editor.canUnnestBlock()) editor.unnestBlock()
      return
    default: {
      const _exhaustive: never = action
      void _exhaustive
    }
  }
}
