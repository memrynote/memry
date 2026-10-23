/**
 * A real BlockNote editor on a real Y.Doc, for the portal tests. Callers mock
 * `react-pdf` and `@/lib/url-metadata` first, as the other editor tests do.
 */

import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { EditorView } from '@tiptap/pm/view'
import { editorSchema } from '../editor-schema'
import { withCollaborationIfLive } from '../collaboration-options'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

export function unmountTestEditors(): void {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
}

export const para = (text: string, children?: PartialBlock[]): PartialBlock =>
  ({ type: 'paragraph', content: text, children }) as PartialBlock

export function mountTestEditor(blocks: PartialBlock[]): {
  editor: BlockNoteEditor
  view: EditorView
} {
  const doc = new Y.Doc()
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(doc.getXmlFragment(CRDT_FRAGMENT_NAME), { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })
  editor.replaceBlocks(editor.document, blocks)
  const view = (editor as unknown as { _tiptapEditor: { view: EditorView } })._tiptapEditor.view
  return { editor, view }
}
