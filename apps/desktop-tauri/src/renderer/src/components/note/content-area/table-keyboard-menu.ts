/**
 * Which keypress opens the table's row/column menu from the caret's cell.
 *
 * A pure predicate rather than a branch inside the overlay so the combination
 * can be asserted without a live editor — see `table-keyboard-menu.test.ts`.
 *
 * Three keys, because no single one reaches every keyboard:
 *   - `ContextMenu`, the dedicated key on a full PC keyboard
 *   - `Shift+F10`, the same request on a keyboard without that key. On a Mac
 *     with the default function-key setting this is a media key and never
 *     reaches the renderer, which is why it is not the only binding
 *   - `Mod+Shift+Enter`, the one that works on every keyboard including a
 *     MacBook's. `Mod-Shift-Enter` is unbound in BlockNote 0.47 (its own
 *     `Mod-Shift-*` keys are the list types, 6 through 9) and in
 *     prosemirror-tables
 *
 * All three are only read while the caret is inside a table cell; anywhere else
 * the event is left alone.
 */
export function isTableMenuShortcut(event: KeyboardEvent): boolean {
  if (event.altKey) return false

  if (event.key === 'ContextMenu') return !event.metaKey && !event.ctrlKey

  if (event.key === 'F10') return event.shiftKey && !event.metaKey && !event.ctrlKey

  return event.key === 'Enter' && event.shiftKey && (event.metaKey || event.ctrlKey)
}
