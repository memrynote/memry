/**
 * Decides which mounted CaptureBar owns the global `q` focus shortcut.
 *
 * Split view can show two capture surfaces at once (Inbox beside Tasks), and
 * every mounted bar binds `q` on `window`. Without an owner a single keypress
 * ran every handler and whichever focused last won, so the caret landed in a
 * non-deterministic pane. Each bar registers its field here instead; on a
 * keypress exactly one is the owner — the bar inside the pane the split view
 * marks active, or, when nothing marks a pane active (single-surface renders),
 * the most recently mounted bar.
 *
 * Fields are read through a getter at keypress time, never captured at render
 * time, so the decision always reflects the live DOM.
 */

/** Set by `tab-pane-with-drop-zones` on the pane the split view considers focused. */
const ACTIVE_PANE_SELECTOR = '[data-pane-active="true"]'

type FieldGetter = () => HTMLElement | null

/** Mount order; the last entry is the most recently mounted bar. */
const mountedFields: FieldGetter[] = []

/**
 * Register a capture field for the lifetime of a bar. Returns the unregister
 * function, so the caller can use it directly as an effect cleanup.
 */
export const registerCaptureField = (getField: FieldGetter): (() => void) => {
  mountedFields.push(getField)
  return () => {
    const index = mountedFields.indexOf(getField)
    if (index !== -1) mountedFields.splice(index, 1)
  }
}

/** Whether `field` is the single bar allowed to act on the `q` shortcut right now. */
export const ownsFocusShortcut = (field: HTMLElement | null): boolean => {
  if (!field) return false

  const fields = mountedFields
    .map((getField) => getField())
    .filter((element): element is HTMLElement => element !== null)

  const owner =
    fields.find((element) => element.closest(ACTIVE_PANE_SELECTOR)) ?? fields[fields.length - 1]

  return owner === field
}
