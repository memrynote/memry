import { describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

import { editorSchema } from './editor-schema'
import { insertColumnList } from './columns-slash-menu'

function createEditor() {
  const editor = BlockNoteEditor.create({ schema: editorSchema })
  editor.mount(document.createElement('div'))
  return editor
}

describe('insertColumnList', () => {
  it('turns an empty line into a column list and puts the caret in the first column', () => {
    const editor = createEditor()
    editor.replaceBlocks(editor.document, [{ type: 'paragraph' }])
    editor.setTextCursorPosition(editor.document[0])

    insertColumnList(editor, 3)

    const [list] = editor.document
    expect(list.type).toBe('columnList')
    expect(list.children.map((column) => column.type)).toEqual(['column', 'column', 'column'])
    expect(editor.getTextCursorPosition().block.id).toBe(list.children[0].children[0].id)
  })

  it('inserts after the enclosing column list when the caret is inside a column', () => {
    // A column holds blocks, not column lists: inserting next to the caret
    // would build a node the schema rejects.
    const editor = createEditor()
    editor.replaceBlocks(editor.document, [{ type: 'paragraph', content: 'Above' }])
    editor.setTextCursorPosition(editor.document[0])
    insertColumnList(editor, 2)

    insertColumnList(editor, 2)

    expect(editor.document.map((block) => block.type).slice(0, 3)).toEqual([
      'paragraph',
      'columnList',
      'columnList'
    ])
  })
})
