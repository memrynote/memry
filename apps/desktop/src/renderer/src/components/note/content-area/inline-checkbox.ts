/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The editor flavour of `inlineCheckbox` — presentation, and the tick.
 *
 * The config, `parse` and `toExternalHTML` — everything that decides what
 * reaches the vault file — live in @memry/editor-schema, so the main process
 * registers the identical node instead of deleting it out of the shared Y.Doc.
 *
 * The interactive half is gated on `renderType === 'nodeView'` for the same
 * reason `inline-image.ts` gates its resize grip: BlockNote reaches this exact
 * function with `renderType: 'dom'` when it SERIALIZES a table cell, and reads
 * the element it gets back. A listener or an extra wrapper leaking into that
 * path is how a cell's markdown stops being `| [ ] task |`.
 *
 * ## Why the toggle is a listener on the node's own DOM, not `handleClickOn`
 * ## and not a delegated listener on the editor surface
 *
 * A delegated `click` listener keyed on `closest('.inline-checkbox')` is the
 * shape that just failed for the wiki-link chip: that chip is an atom rendered
 * `contenteditable="false"`, clicking it parked the caret beside it, a
 * decoration then HID the chip between mousedown and mouseup, and the browser
 * retargeted the `click` to the surviving ancestor — so `closest(...)` found
 * nothing and navigation silently died for every real click. The fix there was
 * `handleClickOn`, which uses the position ProseMirror captured at MOUSEDOWN.
 *
 * This node is the same shape — an atom the user clicks — but not the same
 * situation: nothing hides it, because no decoration paints over it, so its
 * element is still there on mouseup. A listener bound directly to that element
 * cannot be orphaned by retargeting (retargeting only ever walks OUTWARDS, to
 * an ancestor; the element itself is the target as long as it is in the tree).
 * Binding it here rather than in a plugin also keeps the handler and the node
 * on the same lifetime: ProseMirror rebuilds the nodeView when the prop
 * changes, so the closure can never be reading a stale `checked`.
 */

import {
  createInlineCheckboxContent,
  createInlineCheckboxDOM,
  createInlineCheckboxSpec,
  toChecked
} from '@memry/editor-schema/inline'

/**
 * Exported for its own test. BlockNote wraps whatever is handed to
 * `createInlineCheckboxSpec`, and the wrapper calls it without a `this`, so the
 * `nodeView` branch below is only reachable through the real editor — or
 * through this reference.
 */
export function renderInlineCheckbox(
  this: any,
  inlineContent: any,
  updateInlineContent: (content: any) => void,
  editor: any
) {
  const checked = toChecked(inlineContent.props.checked)
  const dom = createInlineCheckboxDOM(checked)

  if (this?.renderType !== 'nodeView') {
    // Serialization and the clipboard. Deliberately nothing but the shared
    // element: this is the path a table cell's markdown comes out of, and a
    // render that throws here makes `yDocToMarkdown` return null and stops the
    // whole note's write-back.
    return { dom }
  }

  const input = dom.querySelector('input')
  if (!input) return { dom }

  // The ATTRIBUTE, not the `contentEditable` IDL property: the two are
  // equivalent in a browser, but jsdom implements only the attribute — so the
  // property form is a line no test can ever see, on the guard that keeps the
  // caret out of the atom.
  dom.setAttribute('contenteditable', 'false')
  input.disabled = editor?.isEditable === false

  // `mousedown` default is what parks the caret and starts a selection drag.
  // Suppressed so a tick is a tick rather than a click that also moves the
  // cursor into the cell — `click` still fires, since preventing mousedown
  // suppresses focus and selection, not the click that follows it.
  input.addEventListener('mousedown', (event: MouseEvent) => {
    if (input.disabled) return
    event.preventDefault()
    event.stopPropagation()
  })

  input.addEventListener('click', (event: MouseEvent) => {
    if (input.disabled) return
    // The native toggle is suppressed and the flip is driven from the document
    // instead: the DOM's own `checked` is not the truth here, the prop is, and
    // letting both move means one undo can leave them disagreeing.
    event.preventDefault()
    event.stopPropagation()
    updateInlineContent(createInlineCheckboxContent(!checked))
  })

  return { dom }
}

export const InlineCheckbox = createInlineCheckboxSpec(renderInlineCheckbox)
