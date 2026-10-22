import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { parsePortalDefinition } from '@memry/shared/portal-block'
import type { EditorSchema } from '../editor-schema'
import { blockDefinition, insertPortalBlock, noteDefinition } from './portal-insert'

// The default BlockNote schema has the same `codeBlock` the note schema does,
// which is all a portal fence is.
const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

async function mountEditor(markdown: string): Promise<BlockNoteEditor> {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  editor.replaceBlocks(editor.document, await editor.tryParseMarkdownToBlocks(markdown))
  return editor
}

const asNoteEditor = (editor: BlockNoteEditor) =>
  editor as unknown as EditorSchema['BlockNoteEditor']

function textOf(block: { content?: unknown }): string {
  return (block.content as Array<{ text: string }>).map((run) => run.text).join('')
}

describe('insertPortalBlock', () => {
  it('writes a memry-portal fence and leaves the caret in the block after it', async () => {
    const editor = await mountEditor('First line\n\nSecond line')
    editor.setTextCursorPosition(editor.document[0], 'end')

    const id = insertPortalBlock(asNoteEditor(editor), blockDefinition('note-1', 'chl-7f2a'))

    const portal = editor.getBlock(id)!
    expect(portal.type).toBe('codeBlock')
    expect(portal.props).toMatchObject({ language: 'memry-portal' })
    const parsed = parsePortalDefinition(textOf(portal))
    expect(parsed.ok && parsed.definition.target).toEqual({
      kind: 'block',
      note: 'note-1',
      block: 'chl-7f2a'
    })

    const cursor = editor.getTextCursorPosition().block
    expect(cursor.id).not.toBe(id)
    expect(editor.getPrevBlock(cursor.id)?.id).toBe(id)
  })

  it('replaces the empty block the slash menu left behind and adds a paragraph at the end', async () => {
    const editor = await mountEditor('Intro')
    const [empty] = editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after')
    editor.setTextCursorPosition(empty, 'start')

    const id = insertPortalBlock(asNoteEditor(editor), noteDefinition('note-2'))

    expect(editor.document.map((block) => block.type)).toEqual([
      'paragraph',
      'codeBlock',
      'paragraph'
    ])
    expect(editor.document[1].id).toBe(id)
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[2].id)
  })
})
