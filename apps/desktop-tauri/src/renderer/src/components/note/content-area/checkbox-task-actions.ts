/**
 * The two explicit crossings between a checkbox and a task, for menus that
 * BlockNote mounts outside `ContentArea` (the block side menu).
 *
 * `ContentArea` registers both, keyed by editor like `marquee-block-registry.ts`,
 * because the menu cannot be handed a prop. Only the editor that owns task side
 * effects registers them, so a template, a review surface or a second copy of
 * the note converts nothing.
 *
 *   - checkbox to task runs `ContentArea`'s own converter, the one the analyzer
 *     and the right-click use, so the task is created, filed and linked the
 *     same way whichever door the user came through;
 *   - task to checkbox rewrites the block (`task-to-checkbox.ts`). The task row
 *     is not touched here: the id leaving the note is a removal like any other,
 *     and the removal prompt asks whether it stays in Tasks.
 */

export interface CheckboxTaskActions {
  toTask: (blockId: string) => void
  toCheckbox: (blockId: string) => void
}

/** The BlockNote editor instance (or any object identity) the entry is keyed by. */
type EditorOwner = WeakKey

const registry = new WeakMap<EditorOwner, CheckboxTaskActions>()

export function registerCheckboxTaskActions(
  editor: EditorOwner,
  actions: CheckboxTaskActions
): () => void {
  registry.set(editor, actions)
  return () => {
    if (registry.get(editor) === actions) registry.delete(editor)
  }
}

export function getCheckboxTaskActions(editor: EditorOwner): CheckboxTaskActions | undefined {
  return registry.get(editor)
}
