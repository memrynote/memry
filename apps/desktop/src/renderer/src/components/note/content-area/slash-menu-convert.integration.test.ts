import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor, getDefaultSlashMenuItems } from '@blocknote/core'
import { convertCurrentBlockOnPick } from './slash-menu-convert'

// The default schema, as in delete-at-doc-end.integration.test.ts: the custom
// schema's extra block specs drag react-pdf into jsdom. The rows are
// BlockNote's own, which ContentArea hands to `convertCurrentBlockOnPick`.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mount(markdown: string): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(markdown))
  return editor
}

function pick(editor: BlockNoteEditor, key: string): void {
  const rows = getDefaultSlashMenuItems(editor).map((item) => ({ ...item, id: item.key }))
  const row = convertCurrentBlockOnPick(editor, rows).find((each) => each.id === key)
  if (!row) throw new Error(`no slash row ${key}`)
  row.onItemClick()
}

const text = (editor: BlockNoteEditor, index: number): string =>
  // oxlint-disable-next-line typescript/no-explicit-any -- inline content is a union; only text runs are read
  ((editor.document[index].content ?? []) as any[]).map((run) => run.text ?? '').join('')

describe('a slash row typed on a line that has text', () => {
  it.each([
    ['heading', 'heading', { level: 1 }],
    ['heading_3', 'heading', { level: 3 }],
    ['heading_5', 'heading', { level: 5 }],
    ['bullet_list', 'bulletListItem', {}],
    ['numbered_list', 'numberedListItem', {}],
    ['check_list', 'checkListItem', {}],
    ['toggle_list', 'toggleListItem', {}],
    ['quote', 'quote', {}],
    ['code_block', 'codeBlock', {}]
  ])('%s turns the line into a %s and keeps its text', (key, type, props) => {
    const editor = mount('Intro')
    editor.setTextCursorPosition(editor.document[0], 'end')

    pick(editor, key)

    expect(editor.document).toHaveLength(1)
    expect(editor.document[0].type).toBe(type)
    expect(editor.document[0].props).toMatchObject(props)
    expect(text(editor, 0)).toBe('Intro')
  })

  it('keeps the indented children of the converted line', () => {
    const editor = mount('- parent\n  - child')
    editor.setTextCursorPosition(editor.document[0], 'end')

    pick(editor, 'numbered_list')

    expect(editor.document).toHaveLength(1)
    expect(editor.document[0].type).toBe('numberedListItem')
    expect(editor.document[0].children.map((child) => child.type)).toEqual(['bulletListItem'])
  })

  it('leaves the caret in the converted line', () => {
    const editor = mount('Intro')
    editor.setTextCursorPosition(editor.document[0], 'end')

    pick(editor, 'heading_2')

    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[0].id)
  })

  it('still inserts a divider after the line, which is not a text type', () => {
    const editor = mount('Intro')
    editor.setTextCursorPosition(editor.document[0], 'end')

    pick(editor, 'divider')

    expect(editor.document.map((block) => block.type)).toEqual([
      'paragraph',
      'divider',
      'paragraph'
    ])
    expect(text(editor, 0)).toBe('Intro')
  })

  it('still inserts a table after the line', () => {
    const editor = mount('Intro')
    editor.setTextCursorPosition(editor.document[0], 'end')

    pick(editor, 'table')

    expect(editor.document.map((block) => block.type)).toEqual(['paragraph', 'table'])
    expect(text(editor, 0)).toBe('Intro')
  })

  it('on an empty line converts it as before', () => {
    const editor = mount('Intro')
    editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after')
    editor.setTextCursorPosition(editor.document[1], 'end')

    pick(editor, 'quote')

    expect(editor.document.map((block) => block.type)).toEqual(['paragraph', 'quote'])
  })
})
