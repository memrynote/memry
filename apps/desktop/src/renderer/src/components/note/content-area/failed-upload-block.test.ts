import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { removeFailedUploadBlock } from './failed-upload-block'

// #5606: a paste whose upload was refused left its image block in the note,
// empty and reading "Loading..." for good. These run against a real BlockNote
// editor, the one whose blocks the placeholder lives among.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

/** A note holding a paragraph and the image block a paste just put after it. */
function editorWithPlaceholder(): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: 'before', type: 'paragraph', content: 'Before the paste' },
      { id: 'placeholder', type: 'image', props: { name: 'image.png' } }
    ]
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

const blockIds = (editor: BlockNoteEditor): string[] => editor.document.map((block) => block.id)

describe('removeFailedUploadBlock', () => {
  it('takes the placeholder of a failed upload out and keeps the rest of the note', () => {
    const editor = editorWithPlaceholder()

    removeFailedUploadBlock(editor, 'placeholder')

    expect(blockIds(editor)).not.toContain('placeholder')
    expect(editor.getBlock('before')?.content).toEqual([
      { type: 'text', text: 'Before the paste', styles: {} }
    ])
  })

  it('leaves the note alone when the user deleted the placeholder while the upload ran', () => {
    const editor = editorWithPlaceholder()
    editor.removeBlocks(['placeholder'])
    const before = blockIds(editor)

    expect(() => removeFailedUploadBlock(editor, 'placeholder')).not.toThrow()
    expect(blockIds(editor)).toEqual(before)
  })
})
