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
 * - Click ON a link is navigation, and stays navigation — and that is enforced
 *   HERE, by `handleClickOn`, not left to a DOM listener elsewhere. It was left
 *   to one, and the paint below is what broke it; the handler's own comment has
 *   the mechanism.
 * - The `[[` and `]]` are REAL characters here, so "ghost brackets" means a
 *   decoration that dims them, not invented ones. Deleting them is allowed:
 *   a user who removes the brackets is turning the link back into prose, which
 *   is a legitimate thing to want.
 *
 * SHOWING the markdown and EDITING it are separate, and the split is the whole
 * design. A caret parked beside a chip — either side, arrow key or mouse —
 * merely PAINTS the markdown (`wikiLinksBesideCursor`, decorations only). The
 * document is not touched, because a cursor movement must not become an edit:
 * that would push a Y.Doc update to every device and land on the Yjs undo
 * stack, so the next Cmd+Z would undo the caret instead of the paragraph the
 * user just deleted. Backspace/ArrowLeft is still the gesture that turns the
 * painted markdown into real, editable text.
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
import { wikiLinkToText } from './wiki-link'

export const WIKI_LINK_EDIT_PLUGIN_KEY = new PluginKey<WikiLinkEditPluginState>('wikiLinkEdit')

/**
 * Marks the transaction that turns a raw run into the chip the user just picked.
 *
 * Separate from the plugin key's own meta (which every internal dispatch sets to
 * mean "this edit is mine, do not re-promote it"): this one is narrower and says
 * WHICH edit it was, because only an insertion suppresses the markdown paint.
 */
const WIKI_LINK_INSERTED_META = 'wikiLinkInserted'

interface WikiLinkEditPluginState {
  /**
   * Where the caret was left by a menu pick, for as long as it stays there.
   *
   * `wikiLinksBesideCursor` paints a link's markdown whenever the caret is
   * beside it — right after an arrow key or a click, which is the gesture that
   * behaviour exists for, and also in the instant a link is created, which it
   * does not. `replaceActiveRunWithWikiLink` leaves the caret against the new
   * chip and writes no trailing space (deliberately — a link picked inside a
   * sentence must not add a character to it), so without this the link the user
   * just made would read back as `[[Note|the words]]` until they moved off it.
   *
   * Null once the selection is anywhere else: the paint is suppressed for that
   * one caret position, not for the chip.
   */
  insertedAt: number | null
}

/** A leaf inline node counts as one character, so text offsets stay aligned. */
const LEAF_PLACEHOLDER = '￼'

const RAW_WIKI_LINK = /\[\[[^[\]]*\]\]/g

const RAW_WIKI_LINK_FULL = /^\[\[([^[\]]*)\]\]$/

/** Characters that would break the `[[target|alias]]` grammar from the inside. */
const ALIAS_UNSAFE = /[[\]|\n\r]+/g

/**
 * `[[…]]` as the EDIT path reads it, which differs from the on-disk reading in
 * two deliberate ways.
 *
 * The first `|` wins and any further pipe segment is dropped. The caret parks at
 * the end of the TARGET, so typing a label into a link that already carries one
 * writes `[[A#B|New|B]]`; the stale tail has to go somewhere and dropping it is
 * plainly what was meant. Only this path normalizes — `parseWikiLinkText` still
 * reads a vault file exactly as it always has, so an existing `[[A|B|C]]` is
 * never rewritten.
 *
 * An EMPTY target parses rather than failing: `[[|Selected text]]` is the state
 * `openWikiLinkForSelection` creates and has to be able to read back.
 */
function parseEditedWikiLinkText(text: string): { target: string; alias: string } | null {
  const match = text.trim().match(RAW_WIKI_LINK_FULL)
  if (!match) return null

  const [rawTarget, rawAlias] = (match[1] ?? '').split('|', 2)
  return { target: rawTarget?.trim() ?? '', alias: rawAlias?.trim() ?? '' }
}

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

/**
 * Every wiki-link chip the caret is sitting immediately beside — on either side,
 * however the caret got there.
 *
 * This is what shows a link's markdown while you are next to it. It reads the
 * SELECTION only and never touches the document: the raw form is painted by a
 * decoration, so putting the caret next to a link stays a cursor movement. The
 * alternative — swapping the node for text the way `unpromote` does — would make
 * a click near a link a real edit: a Y.Doc update to every device, and an entry
 * on the Yjs undo stack, so the next Cmd+Z would undo the caret rather than the
 * paragraph the user just deleted.
 *
 * Both sides can hit at once (`[[A]][[B]]` with the caret between them), so this
 * returns a list rather than the first match.
 */
function wikiLinksBesideCursor(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const selection = state?.selection
  if (!selection?.empty) return []

  const $from = selection.$from
  const found: Array<{ node: ProseMirrorNode; pos: number }> = []

  const before = $from.nodeBefore
  if (before?.type.name === 'wikiLink')
    found.push({ node: before, pos: $from.pos - before.nodeSize })

  const after = $from.nodeAfter
  if (after?.type.name === 'wikiLink') found.push({ node: after, pos: $from.pos })

  return found
}

/** The chip's markdown, split so the brackets can be dimmed on their own. */
function sourceTextOf(node: ProseMirrorNode): string {
  const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
  const alias = typeof node.attrs.alias === 'string' ? node.attrs.alias : ''
  return wikiLinkToText(target, alias)
}

function renderSourceWidget(text: string): HTMLElement {
  const dom = document.createElement('span')
  dom.className = 'wiki-link-source'
  dom.setAttribute('data-wiki-link-source', '')

  const open = document.createElement('span')
  open.className = 'wiki-link-bracket'
  open.textContent = '[['

  const close = document.createElement('span')
  close.className = 'wiki-link-bracket'
  close.textContent = ']]'

  dom.append(open, document.createTextNode(text.slice(2, -2)), close)
  return dom
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
  // Immediately after the `[[`, NOT at the end of the target — the caller opens
  // the suggestion menu here and the menu anchors its query window wherever the
  // caret is at that moment, then moves the caret to the end of the target so
  // the query becomes the target itself.
  //
  // Getting this backwards is not a subtle failure: anchoring at the end of the
  // target makes the query start empty, so typing `#` produces the query `#`,
  // the note half is empty, heading mode never engages and the menu reports "no
  // notes found" on a link whose note plainly exists.
  tr.setSelection(TextSelection.create(tr.doc, pos + 2))
  tr.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
  return tr
}

function hasPlainModifiers(event: KeyboardEvent): boolean {
  return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
}

/**
 * Replaces the raw `[[…]]` run the caret is in with a finished chip.
 *
 * Used when a suggestion is picked while editing an existing link. The menu's
 * own `clearQuery` has already removed the query TEXT by then, but it knows
 * nothing about the brackets around it — with `deleteTriggerCharacter: false`
 * they are left behind, so inserting a chip at the caret would produce
 * `[[<chip>]]`. Replacing the whole run instead leaves exactly the chip.
 *
 * Returns false when the caret is not in a run, so the caller can fall back to
 * an ordinary insert (the from-scratch path, where the menu owns the brackets).
 */
export function replaceActiveRunWithWikiLink(
  editor: { _tiptapEditor?: { state?: EditorState; view?: EditorView } } | undefined,
  attrs: Record<string, unknown>
): boolean {
  const view = editor?._tiptapEditor?.view
  const state = view?.state
  if (!view || !state) return false

  const run = activeRun(state)
  if (!run) return false

  const type = state.schema.nodes.wikiLink
  if (!type) return false

  const tr = state.tr.replaceWith(run.from, run.to, type.create(attrs))
  tr.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
  tr.setMeta(WIKI_LINK_INSERTED_META, true)
  view.dispatch(tr)
  return true
}

type TiptapHost = { _tiptapEditor?: { state?: EditorState; view?: EditorView } }

/**
 * The `{ target, alias }` of the raw run the caret is in, or null.
 *
 * The alias is the half the suggestion query cannot see: the caret sits before
 * the `|`, so a label already on the link — or the text `openWikiLinkForSelection`
 * parked there — never reaches `getItems`. `pickAlias` reads it from here.
 */
export function activeRunWikiLink(
  editor: TiptapHost | undefined
): { target: string; alias: string } | null {
  const state = editor?._tiptapEditor?.state
  if (!state) return null

  const run = activeRun(state)
  if (!run) return null

  return parseEditedWikiLinkText(state.doc.textBetween(run.from, run.to))
}

/**
 * Turns the selected text into a link whose target has not been chosen yet:
 * `[[|Selected text]]`, caret right after the `[[`, suggestion menu bound to it.
 *
 * This is "link this selection to a note or heading" (#1563 E2), and it goes
 * through the same raw-run state a chip being edited does rather than opening a
 * second insertion path. The selection becomes the ALIAS, so picking a target
 * leaves the sentence reading exactly as it did — `pickAlias` carries it over.
 *
 * The step order is the same load-bearing one as the chip-edit path: the caret
 * must be immediately after the `[[` when the menu opens, because that is where
 * the menu anchors its query window. The `|alias` sits AFTER the caret, so it is
 * invisible to the query and untouched by typing.
 */
export function openWikiLinkForSelection(
  editor: TiptapHost | undefined,
  options: WikiLinkEditPluginOptions = {}
): boolean {
  const view = editor?._tiptapEditor?.view
  const state = view?.state
  if (!view || !state) return false

  const { from, to, $from, $to } = state.selection
  if (from === to) return false
  if (!$from?.parent?.isTextblock || $from.parent.type.spec.code) return false
  // One block only: a selection crossing a block boundary has no single place to
  // put the link, and its text is not one run to use as a label.
  if ($from.parent !== $to?.parent) return false

  const alias = state.doc.textBetween(from, to, ' ').replace(ALIAS_UNSAFE, '').trim()
  if (!alias) return false

  const tr = state.tr.replaceWith(
    from,
    to,
    state.schema.text(`[[|${alias}]]`, $from.marksAcross($to) ?? [])
  )
  tr.setSelection(TextSelection.create(tr.doc, from + 2))
  tr.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
  view.dispatch(tr)

  options.openMenu?.()
  return true
}

export interface WikiLinkEditPluginOptions {
  /**
   * Opens the `[[` suggestion menu at the caret WITHOUT inserting a trigger.
   *
   * The menu is a live plugin session, not something derived from document text
   * — a claim this file's header used to get wrong. Un-promoting a chip left
   * well-formed `[[…]]` text with no session attached, so typing `#` inside it
   * opened nothing and the heading picker was unreachable from the path users
   * actually take. The caret is parked right after the `[[` before this runs, so
   * the menu's query window starts where a hand-typed link's would.
   */
  openMenu?: () => void

  /**
   * Follow the link the user clicked. Given the chip's `target`, trimmed.
   *
   * The plugin owns navigation because only the plugin knows where the click
   * LANDED rather than where it ended up — see `handleClickOn`.
   */
  onNavigate?: (target: string) => void
}

export function createWikiLinkEditPlugin(options: WikiLinkEditPluginOptions = {}): Plugin {
  return new Plugin<WikiLinkEditPluginState>({
    key: WIKI_LINK_EDIT_PLUGIN_KEY,

    state: {
      init: () => ({ insertedAt: null }),

      apply(tr, value, _oldState, newState) {
        if (tr.getMeta(WIKI_LINK_INSERTED_META)) return { insertedAt: newState.selection.from }
        if (value.insertedAt === null) return value

        // Mapped rather than compared raw: a remote edit earlier in the doc
        // moves the caret's position without the caret going anywhere, and the
        // chip should stay a chip through that.
        const insertedAt = tr.mapping.map(value.insertedAt)
        const selection = newState.selection
        if (!selection.empty || selection.from !== insertedAt) return { insertedAt: null }
        return { insertedAt }
      }
    },

    props: {
      decorations(state) {
        const decorations: Decoration[] = []

        const run = activeRun(state)
        if (run) {
          decorations.push(
            Decoration.inline(run.from, run.from + 2, { class: 'wiki-link-bracket' }),
            Decoration.inline(run.to - 2, run.to, { class: 'wiki-link-bracket' })
          )
        }

        // A chip the caret is beside reads as its markdown for as long as the
        // caret stays there. The chip is hidden rather than replaced, and the
        // markdown is a widget, so nothing here reaches the document.
        const insertedAt = WIKI_LINK_EDIT_PLUGIN_KEY.getState(state)?.insertedAt ?? null

        for (const beside of wikiLinksBesideCursor(state)) {
          // The chip the caret was just left against by a menu pick reads as a
          // chip until the caret moves — see `WikiLinkEditPluginState`.
          if (insertedAt !== null && beside.pos + beside.node.nodeSize === insertedAt) continue

          const text = sourceTextOf(beside.node)
          if (!text) continue

          decorations.push(
            Decoration.node(beside.pos, beside.pos + beside.node.nodeSize, {
              class: 'wiki-link-hidden'
            }),
            Decoration.widget(beside.pos, () => renderSourceWidget(text), {
              side: -1,
              key: `wiki-link-source:${text}`,
              // NOT `raw`: that is a ProseMirror widget FLAG, and a truthy one
              // makes PM skip both `contentEditable = 'false'` and the
              // `ProseMirror-widget` class on the node it renders. The painted
              // `[[…]]` then became editable DOM that is not in the document —
              // the caret could walk into it and the typing went nowhere.
              sourceText: text
            })
          )
        }

        return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null
      },

      /**
       * Following a link is a ProseMirror handler, NOT a DOM click listener,
       * because by the time a `click` event fires the chip is no longer under
       * the mouse.
       *
       * The chip is `contenteditable="false"`, so mousedown parks the caret
       * immediately beside it. `decorations` above then does exactly what it is
       * meant to do: it hides the chip (`wiki-link-hidden` → `display: none`)
       * and paints the raw `[[Target]]` in its place. Chromium queues that
       * repaint off `selectionchange`, and for a human click — mouse held 80ms,
       * 150ms — it lands BETWEEN mousedown and mouseup. By mouseup there is no
       * chip element left to be the click's target, so the browser retargets the
       * event to the nearest surviving ancestor, the paragraph;
       * `closest('[data-wiki-link]')` finds nothing and the click does nothing.
       * The user is left looking at painted markdown, which reads as the note
       * having dropped into "edit mode" — the regression 52c6cd07f introduced by
       * adding the paint under a listener that could not survive it.
       *
       * A synthetic zero-delay click still hits the chip, which is why this was
       * green in E2E and broken for every real user.
       *
       * ProseMirror is immune to it: `MouseDown` captures `posAtCoords` at
       * MOUSEDOWN and hands that position to `handleClickOn` on mouseup (it only
       * re-hit-tests when the DOCUMENT changed, and a decoration is not a
       * document change). Returning true makes PM `preventDefault()` the mouseup
       * as well, so the caret is never parked beside the chip and the markdown
       * paint the user was seeing never happens at all.
       *
       * Modified clicks fall through deliberately: shift-click extends a
       * selection, and leaving the rest alone keeps a future open-in-new-tab
       * free to claim them.
       */
      handleClickOn(
        _view: EditorView,
        _pos: number,
        node: ProseMirrorNode,
        _nodePos: number,
        event: MouseEvent,
        direct: boolean
      ): boolean {
        // `direct` false means the click was inside some ancestor of the chip,
        // which is an ordinary click in the paragraph.
        if (!direct || node.type.name !== 'wikiLink') return false
        if (event.button !== 0) return false
        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
        if (!options.onNavigate) return false

        const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
        if (!target) return false

        options.onNavigate(target)
        return true
      },

      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        // Backspace on a chip used to delete it outright; now it opens it. That
        // is a deliberate change for EVERY wiki link, not only heading ones —
        // the chip is still one more Backspace away once the text is raw.
        if (event.key !== 'Backspace' && event.key !== 'ArrowLeft') return false
        if (!hasPlainModifiers(event)) return false

        const before = wikiLinkBeforeCursor(view.state)
        if (!before) return false

        const target = typeof before.node.attrs.target === 'string' ? before.node.attrs.target : ''
        const tr = unpromote(view.state, before.node, before.pos)
        if (!tr) return false

        view.dispatch(tr)

        // Bind the raw text to a live suggestion session. Three steps, and the
        // order is the whole trick: `unpromote` left the caret right after the
        // `[[`, the menu anchors its query window at the caret, and only then
        // does the caret move to the end of the target — which makes the query
        // the target itself. Typing `#` extends that query, so the heading
        // picker opens on a note whose title is exact by construction, with no
        // typing it out and no typo to get wrong.
        if (options.openMenu) options.openMenu()

        // Unconditional: with no menu to open, the caret still belongs at the
        // end of the target rather than parked between the brackets.
        const end = before.pos + 2 + target.length
        if (end <= view.state.doc.content.size) {
          const move = view.state.tr.setSelection(TextSelection.create(view.state.doc, end))
          move.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
          view.dispatch(move)
        }

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

      const parsed = parseEditedWikiLinkText(newState.doc.textBetween(from, to))
      if (!parsed) return null

      const type = newState.schema.nodes.wikiLink
      if (!type) return null

      // A run with no target is "link this selection", abandoned before a target
      // was picked (or a target backspaced away). Unwrap it back to the plain
      // text it was made from rather than leaving `[[|Selected text]]` behind —
      // that would be written to the vault verbatim.
      if (!parsed.target) {
        const cancel = parsed.alias
          ? newState.tr.replaceWith(
              from,
              to,
              newState.schema.text(parsed.alias, newState.doc.resolve(from + 2).marks())
            )
          : newState.tr.delete(from, to)
        cancel.setMeta(WIKI_LINK_EDIT_PLUGIN_KEY, true)
        return cancel
      }

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
