/**
 * An editor refuses its own changes of the document while the window holds typing for an outside
 * edit of the note (`sync/typing-hold.ts`): typing made before the edit's frame arrives would land
 * in blocks the edit deletes, and be lost. Updates from the document (the edit itself, another
 * window's) still apply, and a composition is never cut: its transactions pass, and the hold
 * waits for it to end before it starts.
 *
 * @module note/content-area/typing-hold-plugin
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from 'y-prosemirror'
import type { TypingHold } from '@/sync/typing-hold'

export function createTypingHoldPlugin(hold: TypingHold): Plugin {
  let view: EditorView | null = null
  return new Plugin({
    key: new PluginKey('typingHold'),
    view(editorView) {
      view = editorView
      return {
        destroy() {
          // An editor that goes mid-composition must not leave the hold waiting for its end.
          if (view?.composing) hold.compositionEnded()
          view = null
        }
      }
    },
    filterTransaction(tr) {
      return (
        !hold.held ||
        !tr.docChanged ||
        tr.getMeta(ySyncPluginKey)?.isChangeOrigin === true ||
        tr.getMeta('composition') !== undefined ||
        view?.composing === true
      )
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
