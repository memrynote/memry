/**
 * Arrow keys reach a view block. Its definition is `display: none` until the
 * caret is inside, so the browser's own caret movement can never enter it; the
 * plugin makes that one move and leaves every other arrow key alone.
 */

import { BlockNoteEditor } from '@blocknote/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

// pdf.js touches `DOMMatrix` at import time, which jsdom has none of.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

import { editorSchema } from './editor-schema'
import { viewBlockEntry } from './view-block-keys-plugin'

describe('viewBlockEntry', () => {
  const editors: BlockNoteEditor<any, any, any>[] = []

  afterEach(() => {
    for (const editor of editors.splice(0)) editor._tiptapEditor.destroy()
  })

  function editorWith(language: string) {
    const editor = BlockNoteEditor.create({
      schema: editorSchema,
      initialContent: [
        { id: 'above', type: 'paragraph', content: 'Above' },
        {
          id: 'view',
          type: 'codeBlock',
          props: { language },
          content: '{"source":{"kind":"vault"}}'
        },
        { id: 'below', type: 'paragraph', content: 'Below' }
      ]
    } as never) as BlockNoteEditor<any, any, any>
    editors.push(editor)
    return editor
  }

  it('enters the definition at its start going down, and at its end going up', () => {
    // #given
    const editor = editorWith('memry-view')

    // #when / #then from the line above
    editor.setTextCursorPosition('above', 'end')
    const down = viewBlockEntry(editor.prosemirrorState, 1)
    expect(down?.$head.parent.type.name).toBe('codeBlock')
    expect(down?.$head.parentOffset).toBe(0)

    // from the line below
    editor.setTextCursorPosition('below', 'start')
    const up = viewBlockEntry(editor.prosemirrorState, -1)
    expect(up?.$head.parent.type.name).toBe('codeBlock')
    expect(up?.$head.parentOffset).toBe(up?.$head.parent.content.size)
  })

  it('leaves an ordinary code block to the browser', () => {
    const editor = editorWith('javascript')
    editor.setTextCursorPosition('above', 'end')
    expect(viewBlockEntry(editor.prosemirrorState, 1)).toBeNull()
  })

  it('leaves a move away from the view block to the browser', () => {
    const editor = editorWith('memry-view')
    editor.setTextCursorPosition('above', 'start')
    expect(viewBlockEntry(editor.prosemirrorState, -1)).toBeNull()
  })
})
