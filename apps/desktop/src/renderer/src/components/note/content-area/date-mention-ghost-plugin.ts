/**
 * Inline ghost-text autocomplete for the `@`-date mention.
 *
 * While the user types a date-ish `@` query, this plugin:
 *  - paints a neutral "activated" background over the typed `@query`
 *    (`.date-mention-typing`), and
 *  - previews the rest of the best completion as faded ghost text at the cursor
 *    (`.date-mention-ghost`).
 *
 * Tab fills the ghost into real text; a second Tab (once the phrase is a complete
 * date with nothing left to fill) commits the date pill via `onAcceptPill`. All
 * matching/decision logic lives in the unit-tested `date-mention-ghost` module;
 * this file is the ProseMirror glue, mirroring `critic-markup-decorations.ts`
 * (decorations) and `hash-tag-inline-plugin.ts` (cursor scan + handleKeyDown).
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Selection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { findActiveDateQuery, resolveTabAction } from './date-mention-ghost'
import type { DateMentionValue } from './date-mention-popover'

const PLUGIN_KEY = new PluginKey('dateMentionGhost')

interface ActiveMention {
  atPos: number
  cursorPos: number
  query: string
  prediction: string | null
}

// The date `@` mention being typed at a collapsed caret, resolved to absolute
// document positions, or null when the caret is not inside a date-ish `@query`.
// Typed structurally on `{ selection }` (the only field read) so both an
// `EditorState` and a `Transaction` can be passed — the latter lets `shouldOpen`
// gates reuse this without an `EditorState`.
function getActiveDateMention(state: { selection: Selection }): ActiveMention | null {
  const { selection } = state
  if (!selection.empty) return null

  const $from = selection.$from
  const parent = $from.parent
  if (parent.type.spec.code) return null

  const textUpToCursor = parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const active = findActiveDateQuery(textUpToCursor)
  if (!active) return null

  return {
    atPos: $from.start() + active.atIndex,
    cursorPos: $from.pos,
    query: active.query,
    prediction: active.prediction
  }
}

/**
 * True when the caret sits inside an active date-ish `@` mention — the same
 * predicate that drives the ghost highlight. Used to gate BlockNote's `:` emoji
 * picker (via `shouldOpen`) so typing a time like `@today 23:20` never opens it.
 */
export function isDateMentionActive(state: { selection: Selection }): boolean {
  return getActiveDateMention(state) !== null
}

/**
 * True when the caret sits inside a date `@` mention that still has ghost text to
 * fill (e.g. a time being typed: `@today 12` → ghost `:00`). The `@` quick-insert
 * menu gates its `shouldOpen` off this so Tab is owned by the inline ghost (which
 * fills the time) instead of the menu committing a no-time date pill.
 */
export function dateMentionHasGhostFill(state: { selection: Selection }): boolean {
  const active = getActiveDateMention(state)
  if (!active) return false
  return resolveTabAction(active.query)?.kind === 'fill'
}

function ghostWidget(text: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'date-mention-ghost'
  span.textContent = text
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('aria-hidden', 'true')
  return span
}

export interface DateMentionGhostOptions {
  /** Replace the `@query` range [from, to] with a committed date pill. */
  onAcceptPill: (from: number, to: number, value: DateMentionValue) => void
}

export function createDateMentionGhostPlugin({ onAcceptPill }: DateMentionGhostOptions): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,

    props: {
      decorations(state) {
        const active = getActiveDateMention(state)
        if (!active) return null

        const decorations: Decoration[] = [
          Decoration.inline(active.atPos, active.cursorPos, { class: 'date-mention-typing' })
        ]

        const remaining = active.prediction ? active.prediction.slice(active.query.length) : ''
        if (remaining.length > 0) {
          decorations.push(
            Decoration.widget(active.cursorPos, () => ghostWidget(remaining), {
              side: 1,
              key: `dm-ghost:${remaining}`
            })
          )
        }

        return DecorationSet.create(state.doc, decorations)
      },

      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (event.key !== 'Tab') return false
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false

        const active = getActiveDateMention(view.state)
        if (!active) return false

        // We own Tab while a date mention is active (don't fall through to block
        // indent), even if there is nothing actionable.
        event.preventDefault()

        const action = resolveTabAction(active.query)
        if (!action) return true

        if (action.kind === 'fill') {
          const queryStart = active.atPos + 1
          const tr = view.state.tr.insertText(action.text, queryStart, active.cursorPos)
          view.dispatch(tr.scrollIntoView())
          return true
        }

        onAcceptPill(active.atPos, active.cursorPos, action.value)
        return true
      }
    }
  })
}
