/**
 * `inlineCheckbox` inline content spec — a tickable box INSIDE a line of text.
 *
 * BlockNote's own `checkListItem` is a BLOCK (`content: "inline"`), and a
 * `tableCell` is `content: "tableContent+"` whose only member is
 * `tableParagraph` (`content: "inline*"`). There is no position inside a cell
 * that can hold a block, so a checklist in a table was unreachable from every
 * direction at once: the `[ ] ` input rule never fired (BlockNote bails when
 * the cursor block's schema content is not `"inline"`, and inside a cell
 * `getTextCursorPosition` resolves to the TABLE block), `/check` inserted the
 * block AFTER the table, and the toolbar toggle filtered the table block out
 * and did nothing. That is the checklist half of the tables report.
 *
 * The on-disk form is plain literal text — `| [ ] task |`. GFM's task-list
 * syntax is LIST-ITEM only, so `[ ]` inside a cell is not a checkbox to any
 * markdown parser; it is four ordinary characters that every other tool will
 * keep verbatim. So this adds a node type, not a file format.
 *
 * ## Why the DOM is `<span><input type="checkbox"> </span>`
 *
 * Measured against the real rehype-remark pipeline, because the obvious shape
 * is wrong: a BARE `<input type="checkbox">` followed by text serializes to
 * `| [ ]task |` — no space. BlockNote's `addSpacesToCheckboxes` rehype plugin
 * only inserts that space when the input's next sibling is a `<p>`, which is
 * the checkListItem shape and never ours. Carrying the space inside the node's
 * own element is what makes `| [ ] task |` come back byte-stable.
 *
 * ## Why `parse` only claims a checkbox inside a cell
 *
 * Same reasoning as `inline-image.ts`: outside a cell a checkbox is
 * `checkListItem`'s, and claiming every `<input type=checkbox>` would convert
 * every checklist in every existing note into inline ones. `runsBefore` is what
 * guarantees this spec is asked first (BlockNote turns it into the TipTap
 * priority that orders ProseMirror's parse rules), and the `td`/`th` test is
 * what stops it answering yes anywhere the block still belongs.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'

export const inlineCheckboxConfig = {
  type: 'inlineCheckbox' as const,
  propSchema: {
    checked: { default: false, type: 'boolean' as const }
  },
  content: 'none' as const
}

export interface InlineCheckboxProps {
  checked: boolean | string
}

/**
 * A `checked` prop as a boolean, whatever it arrived as.
 *
 * Attributes seeded straight into the shared Y.Doc are STRINGS — that is how a
 * synced note delivers them — and `Boolean("false")` is `true`. An unticked box
 * arriving from another device would tick itself, silently, and then replicate
 * that back. Same landmine `toWidth` exists for on `inlineImage`.
 */
export function toChecked(value: unknown): boolean {
  if (typeof value === 'string') return value === 'true'
  return value === true
}

export function createInlineCheckboxContent(checked = false) {
  return { type: 'inlineCheckbox' as const, props: { checked } }
}

/**
 * The element BOTH processes must emit, for serialization and for the editor.
 *
 * Shared rather than written twice: a table cell serializes its inline content
 * through `render` (with `renderType: 'dom'`), not through `toExternalHTML`, so
 * the two paths landing on different markup is exactly how `linkMention` came
 * to rewrite every mention inside a cell. The trailing space is load-bearing —
 * see the header.
 */
export function createInlineCheckboxDOM(checked: boolean): HTMLSpanElement {
  const wrap = document.createElement('span')
  wrap.className = 'inline-checkbox'

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  // The ATTRIBUTE, not just the property: the serializer reads this element's
  // markup, and `.checked` alone is invisible to it — `| [x] |` would go back
  // to disk as `| [ ] |` and the tick would be lost on the next save.
  if (checked) input.setAttribute('checked', '')

  wrap.appendChild(input)
  wrap.appendChild(document.createTextNode(' '))
  return wrap
}

type InlineCheckboxRender = CustomInlineContentImplementation<
  typeof inlineCheckboxConfig,
  never
>['render']

/**
 * A cell is the only place an inline checkbox is the right answer. Everywhere
 * else an `<input type=checkbox>` belongs to `checkListItem`, and claiming it
 * here would silently convert every existing note's checklists on their next
 * load.
 */
function isInsideTableCell(element: HTMLElement): boolean {
  return element.closest('td, th') !== null
}

/** Everything that decides the node's on-disk form. Shared by both processes. */
export const inlineCheckboxSerialization = {
  parse: (element: HTMLElement) => {
    if (element.tagName !== 'INPUT') return undefined
    const input = element as HTMLInputElement
    if (input.type !== 'checkbox' || !isInsideTableCell(element)) return undefined
    return { checked: input.checked }
  },
  toExternalHTML: (inlineContent: { props: InlineCheckboxProps }) => ({
    dom: createInlineCheckboxDOM(toChecked(inlineContent.props.checked))
  })
}

export function createInlineCheckboxSpec(
  render: InlineCheckboxRender
): InlineContentSpec<typeof inlineCheckboxConfig> {
  return createInlineContentSpec(inlineCheckboxConfig, {
    render,
    ...inlineCheckboxSerialization,
    // Asked before BlockNote's `checkListItem` block, which also parses
    // `<input type=checkbox>`. In 0.47.1 that rule's own input branch compares
    // `tagName === "input"` lowercase and so never fires for real HTML, but
    // relying on somebody else's typo is not a contract: if it is ever fixed,
    // the block rule wins the race and ProseMirror drops the block it built,
    // because a cell has no position that can hold one.
    runsBefore: ['checkListItem']
  })
}
