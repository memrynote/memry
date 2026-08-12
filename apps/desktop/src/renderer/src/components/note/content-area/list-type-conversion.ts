import type { Block, BlockNoteEditor } from '@blocknote/core'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyEditor = BlockNoteEditor<any, any, any>
type AnyBlock = Block<any, any, any>
/* eslint-enable @typescript-eslint/no-explicit-any */

export const LIST_BLOCK_TYPES = ['bulletListItem', 'numberedListItem', 'checkListItem'] as const

export type ListBlockType = (typeof LIST_BLOCK_TYPES)[number]

// Same guard BlockNote's own `Mod-Shift-8` shortcut uses: only blocks whose
// schema content is inline text can become a list item. This keeps our custom
// blocks with `content: 'none'` (taskBlock, file, bookmark, youtubeEmbed) out of
// a bulk retype — for taskBlock that matters beyond formatting, because the
// editor's change handler deletes the task row when its block disappears.
function canConvert(editor: AnyEditor, block: AnyBlock): boolean {
  return editor.schema.blockSchema[block.type]?.content === 'inline'
}

/**
 * Blocks a list toggle applies to: every convertible block in the selection,
 * or the block holding the text cursor when nothing is selected.
 */
export function getBlocksForListConversion(editor: AnyEditor): AnyBlock[] {
  const selected = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block]
  return selected.filter((block: AnyBlock) => canConvert(editor, block))
}

/** True when every block the toggle would touch is already that list type. */
export function isListTypeActive(editor: AnyEditor, type: ListBlockType): boolean {
  const blocks = getBlocksForListConversion(editor)
  return blocks.length > 0 && blocks.every((block) => block.type === type)
}

export function canToggleListType(editor: AnyEditor): boolean {
  return getBlocksForListConversion(editor).length > 0
}

/**
 * Turns every selected block into `type`, or back into paragraphs when they all
 * already are it. Props are left alone so colours and alignment survive the
 * retype; BlockNote drops the ones the new type doesn't declare.
 */
export function toggleListType(editor: AnyEditor, type: ListBlockType): void {
  const blocks = getBlocksForListConversion(editor)
  if (blocks.length === 0) return

  const nextType = blocks.every((block) => block.type === type) ? 'paragraph' : type

  editor.focus()
  editor.transact(() => {
    for (const block of blocks) {
      editor.updateBlock(block, { type: nextType })
    }
  })
}
