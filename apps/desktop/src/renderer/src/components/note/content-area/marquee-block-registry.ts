/**
 * The marquee (drag-from-the-margin) block selection, reachable from the editor.
 *
 * A marquee selection lives in React state inside `ContentArea`, not in
 * ProseMirror: starting one blurs the editor and leaves the ProseMirror
 * selection wherever it was. A press in the margin also runs the note page's
 * click-to-focus-end handler, so that leftover selection is a caret on the last
 * line. Anything that retypes "the selected blocks" by asking the editor
 * (`getSelection()` / `getTextCursorPosition()`) therefore hit the last line,
 * even an empty one, instead of the highlighted blocks.
 *
 * Keyed by editor so the toolbar and the block menu, which BlockNote mounts and
 * remounts on its own schedule, can read it without prop threading.
 */

export interface BlockSelection {
  /** Selected block ids in document order. */
  getIds: () => string[]
  clear: () => void
}

const registry = new WeakMap<object, BlockSelection>()

export function registerBlockSelection(editor: object, selection: BlockSelection): () => void {
  registry.set(editor, selection)
  return () => {
    if (registry.get(editor) === selection) registry.delete(editor)
  }
}

export function getBlockSelection(editor: object): BlockSelection | undefined {
  return registry.get(editor)
}

/**
 * Blocks in the marquee selection, or null when there is none. Ids that no
 * longer resolve (deleted since the drag) drop out.
 */
export function getMarqueeSelectedBlocks<T>(editor: {
  getBlock: (id: string) => T | undefined
}): T[] | null {
  const ids = registry.get(editor)?.getIds() ?? []
  if (ids.length === 0) return null
  const blocks = ids
    .map((id) => editor.getBlock(id))
    .filter((block): block is T => block !== undefined)
  return blocks.length > 0 ? blocks : null
}
