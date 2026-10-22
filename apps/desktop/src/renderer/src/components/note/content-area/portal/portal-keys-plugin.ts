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
 * @module note/content-area/portal/portal-keys-plugin
 */

import { useEffect } from 'react'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'
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

export function createPortalKeysPlugin(): Plugin {
  return new Plugin({
    key: portalKeysPluginKey,
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
        const { state } = view
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

/** Editors that already carry the plugin, with how many portal blocks use it. */
const attached = new Map<unknown, { count: number; detach: (() => void) | undefined }>()

/** Keep the keys plugin on `editor` for as long as one portal block is mounted in it. */
export function usePortalKeysPlugin(editor: unknown): void {
  useEffect(() => {
    let entry = attached.get(editor)
    if (!entry) {
      entry = { count: 0, detach: registerEditorPlugin(editor, createPortalKeysPlugin()) }
      attached.set(editor, entry)
    }
    entry.count += 1
    const held = entry
    return () => {
      held.count -= 1
      if (held.count > 0) return
      held.detach?.()
      attached.delete(editor)
    }
  }, [editor])
}
