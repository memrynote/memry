/**
 * Auto-closing brackets for the note editor: `(` writes `()` and `[[` writes
 * `[[]]`, each with the caret inside.
 *
 * `[[` goes through `appendTransaction` instead of `handleTextInput`, because
 * BlockNote's suggestion menu already claims the second `[` in its own
 * `handleTextInput` and opens the link picker. Reacting to the document change
 * it leaves behind adds the `]]` without changing how the picker opens, and the
 * picker's query stops at the caret, so the trailing `]]` never reaches it.
 *
 * The pair is only written before whitespace, a closer, or the end of the
 * block, so typing a bracket in front of a word never swallows the word.
 * Typing the closer over its own pair steps past it, and Backspace between an
 * empty pair removes both halves.
 */

import { ySyncPluginKey } from 'y-prosemirror'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

const PLUGIN_KEY = new PluginKey('autoCloseBrackets')

const LEAF_PLACEHOLDER = '￼'

/** What may follow the caret for a new pair to be written. */
const MAY_PRECEDE_PAIR = /^[\s)\]}>,.;:]?$/

const OPENER_OF = { ')': '(', ']': '[' } as const

interface CaretContext {
  before: string
  after: string
  pos: number
}

/** The text around an empty caret in prose, or null in code or a range selection. */
function caretContext(state: EditorState): CaretContext | null {
  const { selection } = state
  if (!selection.empty) return null

  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code) return null
  if ($from.marks().some((mark) => mark.type.name === 'code')) return null

  const offset = $from.parentOffset
  return {
    before: parent.textBetween(0, offset, undefined, LEAF_PLACEHOLDER),
    after: parent.textBetween(offset, parent.content.size, undefined, LEAF_PLACEHOLDER),
    pos: selection.from
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

function isLocalSingleCharInsert(transactions: readonly Transaction[], char: string): boolean {
  if (transactions.length !== 1) return false

  const [tr] = transactions
  if (!tr.docChanged || tr.getMeta(PLUGIN_KEY) || tr.getMeta(ySyncPluginKey)) return false
  if (tr.getMeta('paste') || tr.getMeta('uiEvent')) return false

  const [step] = tr.steps
  return (
    tr.steps.length === 1 &&
    step instanceof ReplaceStep &&
    step.from === step.to &&
    step.slice.openStart === 0 &&
    step.slice.content.textBetween(0, step.slice.content.size) === char
  )
}

function dispatchTyped(view: EditorView, tr: Transaction): true {
  view.dispatch(tr.setMeta(PLUGIN_KEY, true))
  return true
}

export function createAutoCloseBracketsPlugin(): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,

    props: {
      handleTextInput(view, from, to, text) {
        if (from !== to) return false

        const context = caretContext(view.state)
        if (!context) return false

        if (text === '(' && MAY_PRECEDE_PAIR.test(context.after.slice(0, 1))) {
          const tr = view.state.tr.insertText('()', from)
          return dispatchTyped(view, tr.setSelection(TextSelection.create(tr.doc, from + 1)))
        }

        if ((text === ')' || text === ']') && context.after.startsWith(text)) {
          const opener = OPENER_OF[text]
          if (count(context.before, opener) <= count(context.before, text)) return false
          const tr = view.state.tr
          return dispatchTyped(view, tr.setSelection(TextSelection.create(tr.doc, from + 1)))
        }

        return false
      },

      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' || event.ctrlKey || event.metaKey || event.altKey)
          return false

        const context = caretContext(view.state)
        if (!context) return false

        const reach =
          context.before.endsWith('[[') && context.after.startsWith(']]')
            ? 2
            : context.before.endsWith('(') && context.after.startsWith(')')
              ? 1
              : 0
        if (reach === 0) return false

        return dispatchTyped(view, view.state.tr.delete(context.pos - reach, context.pos + reach))
      }
    },

    appendTransaction(transactions, _oldState, newState) {
      if (!isLocalSingleCharInsert(transactions, '[')) return null

      const context = caretContext(newState)
      if (!context || !context.before.endsWith('[[') || context.before.endsWith('[[[')) return null

      const next = context.after.slice(0, 1)
      if (next === ']' || !MAY_PRECEDE_PAIR.test(next)) return null

      const tr = newState.tr.insertText(']]', context.pos)
      return tr.setSelection(TextSelection.create(tr.doc, context.pos)).setMeta(PLUGIN_KEY, true)
    }
  })
}

/**
 * Drops the `]]` this plugin wrote after a `[[` once the picker has consumed
 * the `[[` and its query, so the chosen link is not followed by a stray `]]`.
 *
 * A caret still right after a `[` is a link being edited in place, whose
 * brackets belong to the raw run, so it is left alone.
 */
export function consumeAutoClosedBrackets(
  editor: { _tiptapEditor?: { view?: EditorView } } | undefined
): void {
  const view = editor?._tiptapEditor?.view
  if (!view) return

  const context = caretContext(view.state)
  if (!context || context.before.endsWith('[') || !context.after.startsWith(']]')) return

  view.dispatch(view.state.tr.delete(context.pos, context.pos + 2).setMeta(PLUGIN_KEY, true))
}
