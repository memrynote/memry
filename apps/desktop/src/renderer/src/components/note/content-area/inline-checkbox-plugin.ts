/**
 * Typing `[ ] ` at the start of a table cell turns it into a checkbox.
 *
 * BlockNote already owns this gesture everywhere else — its `checkListItem`
 * input rules turn `[ ] ` / `[x] ` into a checklist block — and this plugin is
 * deliberately scoped so it can never compete with them. Inside a cell those
 * rules cannot fire at all: `ExtensionManager` bails when the cursor block's
 * schema content is not `"inline"`, and inside a cell `getTextCursorPosition`
 * resolves to the TABLE block (`content: "table"`). So the cell is the one
 * place the gesture does nothing, and the one place this runs.
 *
 * The scope test is `$from.parent.type.name === 'tableParagraph'`, not "is
 * there a table above me": `tableParagraph` is the only member of a cell's
 * `tableContent+`, so it is exactly the set of positions where a checklist
 * BLOCK is impossible and this node is the answer.
 *
 * Modelled on `hash-tag-space-plugin.ts` — same `appendTransaction` shape, same
 * self-meta so the plugin never re-reads its own edit.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'

const PLUGIN_KEY = new PluginKey('inlineCheckboxComplete')

/**
 * The token, and only at the very start of the cell.
 *
 * `[ ] ` mid-sentence stays four characters of prose. A checkbox that is not
 * the first thing in the cell has no meaning to read off — and promoting one
 * would rewrite text somebody typed on purpose.
 */
const LEADING_CHECKBOX = /^\[([ xX])\] $/

/** Length of `[ ] ` — the range replaced, and the offset the caret must be at. */
const TOKEN_LENGTH = 4

export function matchLeadingCheckboxToken(text: string): boolean | null {
  const match = LEADING_CHECKBOX.exec(text)
  if (!match) return null
  return match[1].toLowerCase() === 'x'
}

export function createInlineCheckboxPlugin(): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,

    appendTransaction(transactions, _oldState, newState) {
      const hasDocChange = transactions.some((tr) => tr.docChanged && !tr.getMeta(PLUGIN_KEY))
      if (!hasDocChange) return null

      const { selection } = newState
      const $from = selection.$from
      if ($from.parent.type.name !== 'tableParagraph') return null

      // The space that completes the token is the trigger, so the caret is at
      // exactly `[ ] `'s end. Anywhere else and the user is editing text that
      // merely starts with those characters.
      if ($from.parentOffset !== TOKEN_LENGTH) return null

      const checked = matchLeadingCheckboxToken(
        $from.parent.textBetween(0, TOKEN_LENGTH, undefined, '\ufffc')
      )
      if (checked === null) return null

      const nodeType = newState.schema.nodes.inlineCheckbox
      if (!nodeType) return null

      const start = $from.start()
      const tr = newState.tr.replaceWith(
        start,
        start + TOKEN_LENGTH,
        // The node ALONE — the typed trailing space is consumed, not kept. The
        // box's own DOM carries a space (that is what makes `| [ ] task |`
        // serialize with a gap), so a text space here would be a second one.
        // Markdown collapses the pair, so keeping it would not corrupt the
        // vault — but it would leave a cell the user TYPED holding a different
        // document from the same cell RE-OPENED, which the promoter builds
        // without one. Same bytes, one shape.
        Fragment.from([nodeType.create({ checked })])
      )
      tr.setMeta(PLUGIN_KEY, true)
      return tr
    }
  })
}
