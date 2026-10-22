/**
 * Keyboard access to a portal block in its host note.
 *
 * A portal is a `memry-portal` code block whose text, the definition's JSON,
 * is hidden. Two things go wrong with a hidden textblock. Backspace at the
 * start of the block after it merges that block's text into the JSON, and an
 * arrow key at a block edge hands the caret to the browser, which cannot place
 * one in hidden text. This plugin selects the portal as a whole in both cases:
 * the arrow moves onto it, and Backspace selects it first, so a second
 * Backspace removes only the window (artboard 2) instead of corrupting it.
 *
 * Tab and Shift+Tab on a selected portal indent and outdent it as one block,
 * and Shift-Mod-Arrow (BlockNote's own) moves it as one block.
 *
 * It also answers the window's events: `memry:portal-exit` puts the caret in
 * the host's next (or previous) block, and `memry:portal-select` selects the
 * portal (Backspace at the start of the window's first block).
 *
 * @module note/content-area/portal/portal-keys-plugin
 */

import { useEffect } from 'react'
import type { BlockNoteEditor } from '@blocknote/core'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'
import {
  PORTAL_EXIT_EVENT,
  PORTAL_SELECT_EVENT,
  type PortalExitDetail
} from './portal-boundary-plugin'
import { registerEditorPlugin } from '../register-editor-plugin'

export const portalKeysPluginKey = new PluginKey('portalKeys')

const ARROWS: Readonly<Record<string, { dir: 1 | -1; edge: 'up' | 'down' | 'left' | 'right' }>> = {
  ArrowDown: { dir: 1, edge: 'down' },
  ArrowRight: { dir: 1, edge: 'right' },
  ArrowUp: { dir: -1, edge: 'up' },
  ArrowLeft: { dir: -1, edge: 'left' }
}

/**
 * Selecting the portal whose block lies just past the caret's textblock in
 * `dir`, or null when the neighbour is anything else (which leaves the key to
 * the editor).
 */
export function portalSelectionPast(state: EditorState, dir: 1 | -1): NodeSelection | null {
  const { $head } = state.selection
  if (!$head.parent.isTextblock || $head.depth === 0) return null
  const $outside = state.doc.resolve(dir > 0 ? $head.after() : $head.before())
  const next = Selection.findFrom($outside, dir, true)
  if (!(next instanceof TextSelection)) return null
  const { $head: $target } = next
  const block = $target.parent
  if (block.type.name !== 'codeBlock' || block.attrs.language !== PORTAL_BLOCK_LANGUAGE) return null
  if ($target.depth < 2) return null
  // The portal is the blockContainer around the code block.
  return NodeSelection.create(state.doc, $target.before($target.depth - 1))
}

/** What the plugin needs of the host editor: nesting, and a paragraph to land in. */
export type PortalKeysEditor = Pick<
  BlockNoteEditor<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- the host's schema is not this file's concern
  'nestBlock' | 'unnestBlock' | 'insertBlocks' | 'setTextCursorPosition'
>

function isPortalContainer(node: PMNode): boolean {
  const content = node.firstChild
  return (
    node.type.name === 'blockContainer' &&
    content?.type.name === 'codeBlock' &&
    content.attrs.language === PORTAL_BLOCK_LANGUAGE
  )
}

/** The portal container a window event came from: the nearest block around its target. */
function containerForEvent(view: EditorView, event: Event): { pos: number; node: PMNode } | null {
  const target = event.target instanceof Element ? event.target : null
  const id = target?.closest('[data-node-type="blockContainer"]')?.getAttribute('data-id')
  if (!id) return null
  let found: { pos: number; node: PMNode } | null = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'blockContainer' && node.attrs.id === id) found = { pos, node }
    return !found
  })
  return found && isPortalContainer((found as { node: PMNode }).node) ? found : null
}

function leaveWindow(
  view: EditorView,
  editor: PortalKeysEditor,
  at: { pos: number; node: PMNode },
  direction: PortalExitDetail['direction']
): void {
  const { doc } = view.state
  const end = at.pos + at.node.nodeSize
  const next =
    direction === 'after'
      ? Selection.findFrom(doc.resolve(end), 1, true)
      : Selection.findFrom(doc.resolve(at.pos), -1, true)
  if (next) {
    view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
  } else if (direction === 'after') {
    // The portal is the last block: there is no line below it yet.
    const [created] = editor.insertBlocks(
      [{ type: 'paragraph' }],
      String(at.node.attrs.id),
      'after'
    )
    editor.setTextCursorPosition(created, 'start')
  }
  view.focus()
}

export function createPortalKeysPlugin(editor: PortalKeysEditor): Plugin {
  return new Plugin({
    key: portalKeysPluginKey,
    view(view) {
      const onExit = (event: Event): void => {
        const at = containerForEvent(view, event)
        if (!at) return
        event.stopPropagation()
        const { direction } = (event as CustomEvent<PortalExitDetail>).detail
        leaveWindow(view, editor, at, direction)
      }
      const onSelect = (event: Event): void => {
        const at = containerForEvent(view, event)
        if (!at) return
        event.stopPropagation()
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.pos)))
        view.focus()
      }
      view.dom.addEventListener(PORTAL_EXIT_EVENT, onExit)
      view.dom.addEventListener(PORTAL_SELECT_EVENT, onSelect)
      return {
        destroy() {
          view.dom.removeEventListener(PORTAL_EXIT_EVENT, onExit)
          view.dom.removeEventListener(PORTAL_SELECT_EVENT, onSelect)
        }
      }
    },
    // Nesting and moving rebuild the block, and BlockNote leaves a text caret in
    // the hidden JSON where the selection was. The next Backspace would then
    // edit the definition. A portal that was selected stays selected.
    appendTransaction(transactions, oldState, newState) {
      const before = oldState.selection
      if (!(before instanceof NodeSelection) || !isPortalContainer(before.node)) return null
      if (!transactions.some((tr) => tr.docChanged)) return null
      const after = newState.selection
      const id = before.node.attrs.id
      if (after instanceof NodeSelection && after.node.attrs.id === id) return null
      let pos = -1
      newState.doc.descendants((node, at) => {
        if (pos >= 0) return false
        if (node.type.name === 'blockContainer' && node.attrs.id === id) pos = at
        return pos < 0
      })
      if (pos < 0) return null
      return newState.tr.setSelection(NodeSelection.create(newState.doc, pos))
    },
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        if (event.metaKey || event.ctrlKey || event.altKey) return false
        const { state } = view
        if (event.key === 'Tab') {
          const { selection } = state
          if (!(selection instanceof NodeSelection) || !isPortalContainer(selection.node)) {
            return false
          }
          if (event.shiftKey) editor.unnestBlock()
          else editor.nestBlock()
          return true
        }
        if (event.shiftKey) return false
        if (!state.selection.empty) return false

        let selection: NodeSelection | null = null
        if (event.key === 'Backspace') {
          if (state.selection.$head.parentOffset !== 0) return false
          selection = portalSelectionPast(state, -1)
        } else {
          const move = ARROWS[event.key]
          if (!move || !view.endOfTextblock(move.edge)) return false
          selection = portalSelectionPast(state, move.dir)
        }
        if (!selection) return false
        view.dispatch(state.tr.setSelection(selection).scrollIntoView())
        return true
      }
    }
  })
}

/** Ahead of the editor's own key handlers: BlockNote's Tab would otherwise act on a selected portal first. */
export const prependPlugin = (plugin: Plugin, plugins: Plugin[]): Plugin[] => [plugin, ...plugins]

/** Editors that already carry the plugin, with how many portal blocks use it. */
const attached = new Map<unknown, { count: number; detach: (() => void) | undefined }>()

/** Keep the keys plugin on `editor` for as long as one portal block is mounted in it. */
export function usePortalKeysPlugin(editor: PortalKeysEditor): void {
  useEffect(() => {
    let entry = attached.get(editor)
    if (!entry) {
      entry = {
        count: 0,
        detach: registerEditorPlugin(editor, createPortalKeysPlugin(editor), prependPlugin)
      }
      attached.set(editor, entry)
    }
    entry.count += 1
    const held = entry
    return () => {
      held.count -= 1
      if (held.count > 0) return
      // Nesting or moving the only portal unmounts and remounts it. Detaching
      // in between reconfigures the editor, and its collaboration binding
      // re-renders the document with a text selection in place of the portal's
      // node selection. Detach only when no portal came back.
      setTimeout(() => {
        if (held.count > 0 || attached.get(editor) !== held) return
        held.detach?.()
        attached.delete(editor)
      }, 0)
    }
  }, [editor])
}
