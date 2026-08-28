/** Which surface the note screen is showing. */
export type NoteMode = 'read' | 'edit'

/**
 * Why the note body is or is not editable — two independent reasons, and they
 * are kept apart deliberately.
 *
 * `locked` is the vault-level read-only state, which this screen cannot
 * override. `reading` is the screen's own reader/editor toggle. A single
 * boolean would answer "is the body read-only?" and lose the question `Edit`
 * has to answer: whether flipping the mode could produce an editable surface
 * at all. Offered on a locked vault, `Edit` opens an editor that silently
 * refuses every keystroke. It is also what keeps the tag and property editors
 * live while merely reading, which the collapsed boolean would have disabled.
 *
 * Same collapse `shouldSeedFromMarkdown` documents in `note-ops`.
 */
export type EditGate = 'locked' | 'reading' | 'editing'

export function editGate(input: { vaultReadOnly: boolean; mode: NoteMode }): EditGate {
  // The vault state wins over the mode, so a vault that goes read-only in the
  // middle of an edit stops taking keystrokes rather than collecting them for
  // a push that will never happen.
  if (input.vaultReadOnly) return 'locked'
  return input.mode === 'edit' ? 'editing' : 'reading'
}
