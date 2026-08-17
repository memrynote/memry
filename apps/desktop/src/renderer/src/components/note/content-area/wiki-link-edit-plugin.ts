/**
 * Editing a wiki link that is already a chip.
 *
 * The `[[` autocomplete can write `[[Note#Heading]]` from scratch, but the
 * common path does not go that way: the user types `[[`, picks a note from the
 * dropdown, and now a chip exists. The chip is an atom (`content: 'none'`,
 * rendered `contenteditable="false"`), so the caret cannot get inside it, a `#`
 * typed after it is a separate word, and one Backspace deletes the whole thing.
 * There was no way to add a heading to a link you had just inserted.
 *
 * So editing UN-PROMOTES the chip back to its raw markdown — `[[Target]]`, or
 * `[[Target|Alias]]` — with the caret at the end of the target, which is where
 * a `#` belongs. From there it is plain text: spaces, `#`, anything, and the
 * `[[` suggestion menu (which keys off exactly this text) works unchanged,
 * heading mode included. When the caret leaves the run, the text becomes a chip
 * again.
 *
 * Raw text rather than the `hashTag` shrink/extend-the-attribute pattern
 * (`hash-tag-inline-plugin.ts`, still the precedent for HOW to intercept a key
 * next to an inline node): that plugin absorbs characters by class,
 * `[a-zA-Z0-9_\-/]`, which stops at the first space — and note titles and
 * headings are mostly spaces.
 *
 * Two things this deliberately does not do:
 * - Click is navigation, and stays navigation. Edit mode is keyboard-only.
 * - The `[[` and `]]` are REAL characters here, so "ghost brackets" means a
 *   decoration that dims them, not invented ones. Deleting them is allowed:
 *   a user who removes the brackets is turning the link back into prose, which
 *   is a legitimate thing to want.
 *
 * If the editor loses focus while a run is still raw, the run stays raw — and
 * that is safe, because `[[Target]]` is exactly what the chip serializes to.
 * The bytes on disk are identical either way, and opening the note promotes it.
 */

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Mark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { parseWikiLinkText, wikiLinkToText } from './wiki-link'

export const WIKI_LINK_EDIT_PLUGIN_KEY = new PluginKey('wikiLinkEdit')

/** A leaf inline node counts as one character, so text offsets stay aligned. */
const LEAF_PLACEHOLDER = '￼'

const RAW_WIKI_LINK = /\[\[[^[\]]*\]\]/g

/**
 * The `[[…]]` run the offset sits INSIDE, or null.
 *
 * Strictly inside: an offset on either outer edge is a caret that has left the
 * link, which is what turns the text back into a chip.
 */
export function findWikiLinkRunAt(
  text: string,
  offset: number
): { start: number; end: number } | null {
  const pattern = new RegExp(RAW_WIKI_LINK)
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (offset > start && offset < end) return { start, end }
    if (start > offset) break
  }

  return null
}

/**
 * The chip's marks travel with it into the raw text and back.
 *
 * A wiki link carries its marks as PROPS (#1439 — BlockNote gives custom inline
 * content no `styles` field), while the raw text carries them as ProseMirror
 * marks, so the round trip has to translate. Every lookup is defensive: a mark
 * this schema does not have is simply not carried, never a throw inside a
 * keystroke handler.
 */
const BOOLEAN_MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const
const COLOR_MARKS = ['textColor', 'backgroundColor'] as const

function marksFromProps(schema: Schema, attrs: Record<string, unknown>): Mark[] {
  const marks: Mark[] = []

  for (const name of BOOLEAN_MARKS) {
    if (attrs[name] !== true) continue
    const type = schema.marks[name]
    if (type) marks.push(type.create())
  }

  for (const name of COLOR_MARKS) {
    const value = attrs[name]
    if (typeof value !== 'string' || value === '' || value === 'default') continue
    const type = schema.marks[name]
    if (type) marks.push(type.create({ stringValue: value }))
  }

  return marks
}

function propsFromMarks(marks: readonly Mark[]): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {}

  for (const mark of marks) {
    const name = mark.type.name
    if ((BOOLEAN_MARKS as readonly string[]).includes(name)) {
      props[name] = true
      continue
    }
    if ((COLOR_MARKS as readonly string[]).includes(name)) {
      const value = (mark.attrs as { stringValue?: unknown } | undefined)?.stringValue
      if (typeof value === 'string' && value !== '' && value !== 'default') props[name] = value
    }
  }

  return props
}

function wikiLinkBeforeCursor(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  const selection = state?.selection
  if (!selection?.empty) return null

  const $from = selection.$from
  if ($from.parentOffset === 0) return null

  const nodeBefore = $from.nodeBefore
  if (nodeBefore?.type.name !== 'wikiLink') return null

  return { node: nodeBefore, pos: $from.pos - nodeBefore.nodeSize }
}

/**
 * The raw `[[…]]` run the caret is inside, in absolute document positions.
 *
 * Reads the selection defensively. This runs on the keystroke path and, through
 * `isEditingWikiLinkText`, on every content change from `use-editor-sync` — where
 * the editor may not have a ProseMirror selection at all yet. Throwing there
 * would take the whole change handler down with it, so a state without a
 * selection is simply "not editing a link".
 */
function activeRun(state: EditorState): { from: number; to: number } | null {
  const selection = state?.selection
  if (!selection?.empty) return null

  const $from = selection.$from
  const parent = $from.parent
  if (!parent.isTextblock || parent.type.spec.code) return null

  const text = parent.textBetween(0, parent.content.size, undefined, LEAF_PLACEHOLDER)
  const run = findWikiLinkRunAt(text, $from.parentOffset)
  if (!run) return null

  return { from: $from.start() + run.start, to: $from.start() + run.end }
}

/**
 * True when the caret is inside a raw `[[…]]` run — the state in which
 * whole-document wiki-link normalization must leave this block alone. See
 * `use-editor-sync.ts`, which would otherwise promote the run back into a chip
 * on the very next keystroke, through a full-document `replaceBlocks` under a
 * typing caret.
 */
export function isEditingWikiLinkText(state: EditorState): boolean {
  return activeRun(state) !== null
}

function unpromote(state: EditorState, node: ProseMirrorNode, pos: number): Transaction | null {
  const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
  if (!target) return null

  const alias = typeof node.attrs.alias === 'string' ? node.attrs.alias : ''
  const text = wikiLinkToText(target, alias)

  const tr = state.tr.replaceWith(
    pos,
    pos + node.nodeSize,
    state.schema.text(text, marksFromProps(state.schema, node.attrs))
  )
  // At the END OF THE TARGET, which for `[[Target]]` is "just before the `]]`"
  // and for `[[Target|Alias]]` is just before the `|`. Both are the same spot
  // for the common case, and the alias case is the reason not to say "before
  // the `]]`" and leave it there: a `#` typed after an alias reads as part of
  // the ALIAS, so the link would point at a heading nobody can resolve.
  tr.setSelection(TextSelection.create(tr.doc, pos + 2 + target.length))
  tr.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
  return tr
}

function hasPlainModifiers(event: KeyboardEvent): boolean {
  return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
}

export function createWikiLinkEditPlugin(): Plugin {
  return new Plugin({
    key: WIKI_LINK_EDIT_PLUGIN_KEY,

    props: {
      decorations(state) {
        const run = activeRun(state)
        if (!run) return null

        return DecorationSet.create(state.doc, [
          Decoration.inline(run.from, run.from + 2, { class: 'wiki-link-bracket' }),
          Decoration.inline(run.to - 2, run.to, { class: 'wiki-link-bracket' })
        ])
      },

      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        // Backspace on a chip used to delete it outright; now it opens it. That
        // is a deliberate change for EVERY wiki link, not only heading ones —
        // the chip is still one more Backspace away once the text is raw.
        if (event.key !== 'Backspace' && event.key !== 'ArrowLeft') return false
        if (!hasPlainModifiers(event)) return false

        const before = wikiLinkBeforeCursor(view.state)
        if (!before) return false

        const tr = unpromote(view.state, before.node, before.pos)
        if (!tr) return false

        view.dispatch(tr)
        return true
      }
    },

    /**
     * Promote the run back into a chip once the caret leaves it.
     *
     * This has to live here rather than in the document-wide normalizer: a user
     * who clicks away without typing produces no document change at all, so
     * nothing else would ever run.
     */
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some((tr) => tr.getMeta(WIKI_LINK_EDIT_PLUGIN_KEY))) return null
      if (!transactions.some((tr) => tr.docChanged || tr.selectionSet)) return null

      const previous = activeRun(oldState)
      if (!previous) return null

      let from = previous.from
      let to = previous.to
      for (const tr of transactions) {
        from = tr.mapping.map(from)
        to = tr.mapping.map(to, -1)
      }
      if (to <= from) return null

      const current = activeRun(newState)
      if (current && current.from === from) return null

      const parsed = parseWikiLinkText(newState.doc.textBetween(from, to))
      if (!parsed) return null

      const type = newState.schema.nodes.wikiLink
      if (!type) return null

      const marks = propsFromMarks(newState.doc.resolve(from + 2).marks())
      const tr = newState.tr.replaceWith(
        from,
        to,
        type.create({ target: parsed.target, alias: parsed.alias, ...marks })
      )
      tr.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
      return tr
    }
  })
}
