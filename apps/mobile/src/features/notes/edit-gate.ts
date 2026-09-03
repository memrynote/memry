/**
 * Why the note body is or is not editable.
 *
 * There is one reason left: the vault-level read-only state, which this screen
 * cannot override. The note is otherwise editable from the first frame, so the
 * screen's own reader/editor toggle is gone along with the `Edit` button that
 * drove it.
 *
 * It stays a named union rather than a boolean because `locked` is also what
 * freezes the tag and property editors, and `cfg.readOnly` is derived from it
 * — one word at both call sites beats two inverted booleans.
 */
export type EditGate = 'locked' | 'editing'

export function editGate(input: { vaultReadOnly: boolean }): EditGate {
  return input.vaultReadOnly ? 'locked' : 'editing'
}
