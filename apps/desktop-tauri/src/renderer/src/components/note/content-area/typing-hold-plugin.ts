/**
 * An editor refuses its own changes of the document while the window holds typing for an outside
 * edit of the note (`sync/typing-hold.ts`): typing made before the edit's frame arrives would land
 * in blocks the edit deletes, and be lost. Updates from the document (the edit itself, another
 * window's) still apply, and a composition is never cut: the hold waits for it to end before it
 * starts, and the transactions of one that still ran then pass. A composition that begins during
 * the hold is held like typing: had its text reached the document, it would land in blocks the
 * edit deletes. A refused transaction leaves the IME's text in the DOM and the composition
 * running, and ProseMirror reads the block again at the composition's next change or end, so the
 * text goes in after the release. Undo and redo write the document directly, past the filter, so
 * they do nothing while held.
 *
 * @module note/content-area/typing-hold-plugin
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey, yUndoPluginKey } from 'y-prosemirror'
import type * as Y from 'yjs'
import type { TypingHold } from '@/sync/typing-hold'

export function createTypingHoldPlugin(hold: TypingHold): Plugin {
  let view: EditorView | null = null
  return new Plugin({
    key: new PluginKey('typingHold'),
    view(editorView) {
      view = editorView
      const undoManager: Y.UndoManager | undefined = yUndoPluginKey.getState(
        editorView.state
      )?.undoManager
      const restoreUndo = undoManager && holdUndo(undoManager, hold)
      return {
        destroy() {
          // An editor that goes mid-composition must not leave the hold waiting for its end.
          if (view?.composing) hold.compositionEnded()
          view = null
          restoreUndo?.()
        }
      }
    },
    filterTransaction(tr) {
      if (!hold.held || !tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin === true) {
        return true
      }
      const composition = tr.getMeta('composition') !== undefined || view?.composing === true
      return composition && hold.takesComposition
    },
    props: {
      handleDOMEvents: {
        compositionstart: () => {
          hold.compositionStarted()
          return false
        },
        compositionend: () => {
          hold.compositionEnded()
          return false
        }
      }
    }
  })
}

/** Makes `undoManager`'s undo and redo do nothing while `hold` is held; returns the undo of that. */
function holdUndo(undoManager: Y.UndoManager, hold: TypingHold): () => void {
  const undo = undoManager.undo.bind(undoManager)
  const redo = undoManager.redo.bind(undoManager)
  const heldUndo = (): ReturnType<typeof undo> => (hold.held ? null : undo())
  const heldRedo = (): ReturnType<typeof redo> => (hold.held ? null : redo())
  undoManager.undo = heldUndo
  undoManager.redo = heldRedo
  return () => {
    if (undoManager.undo === heldUndo) undoManager.undo = undo
    if (undoManager.redo === heldRedo) undoManager.redo = redo
  }
}
