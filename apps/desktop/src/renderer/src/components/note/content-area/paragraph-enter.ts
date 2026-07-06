import type { Command } from 'prosemirror-state'

/**
 * Obsidian-style Enter for plain paragraphs.
 *
 * BlockNote (like Notion) treats every Enter as a new block, which serializes to
 * a blank-line-separated paragraph (`a\n\nb`). Vault files authored in Obsidian
 * use single newlines (`a\nb`, a soft break = one logical paragraph). This command
 * makes a mid-paragraph Enter insert a line break instead of splitting the block,
 * so typed lines stay in one paragraph. A second Enter on the now-empty trailing
 * line falls through to BlockNote's default split, giving the familiar
 * "double-Enter = new paragraph" behavior.
 *
 * Only paragraphs are affected — lists, headings, quotes, and code blocks keep
 * BlockNote's native Enter. Returns true when it inserted a break (the caller
 * should then stop the event); returns false to let BlockNote handle Enter.
 */
export const insertParagraphLineBreak: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const $from = selection.$from
  if ($from.parent.type.name !== 'paragraph') return false

  const hardBreak = state.schema.nodes.hardBreak
  if (!hardBreak) return false

  // Empty paragraph → let BlockNote create a new block (nothing to keep together).
  if ($from.parent.content.size === 0) return false

  const before = $from.nodeBefore
  if (before && before.type.name === 'hardBreak') {
    // Cursor sits on an empty trailing line (right after a break) → the user
    // pressed Enter twice. Drop the dangling break and let BlockNote's default
    // Enter split into a fresh paragraph.
    if (dispatch) {
      dispatch(state.tr.delete($from.pos - before.nodeSize, $from.pos).scrollIntoView())
    }
    return false
  }

  // Mid-paragraph Enter → soft line break, stay in the same block.
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(hardBreak.create(), false).scrollIntoView())
  }
  return true
}
