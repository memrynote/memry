import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, getDefaultSlashMenuItems } from '@blocknote/core'
import { SuggestionMenu } from '@blocknote/core/extensions'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { withCollaborationIfLive } from './collaboration-options'
import { convertCurrentBlockOnPick } from './slash-menu-convert'

// The default schema, as in delete-at-doc-end.integration.test.ts: the custom
// schema's extra block specs drag react-pdf into jsdom. The rows are
// BlockNote's own, which ContentArea hands to `convertCurrentBlockOnPick`.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

// The open menu reads its anchor's rect with `toJSON`, which jsdom's lacks.
beforeEach(() => {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    toJSON: () => rect
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

/** `live`: on a Y.Doc, as a note is, so y-prosemirror's undo manager answers
 * undo instead of BlockNote's own history. */
function mount(markdown: string, live = false): BlockNoteEditor {
  const fragment = live ? new Y.Doc().getXmlFragment(CRDT_FRAGMENT_NAME) : undefined
  const editor = BlockNoteEditor.create(withCollaborationIfLive(fragment, {}))
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

/** Types `typed` at the caret as keystrokes, so `/` opens BlockNote's menu. */
function typeKeys(editor: BlockNoteEditor, typed: string): void {
  const view = editor._tiptapEditor.view
  for (const char of typed) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (handle) =>
      handle(view, from, to, char, () => view.state.tr.insertText(char, from, to))
    )
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to))
  }
}

/** Picks `key` from the open `/` menu as the menu does: it closes, its
 * `/query` goes, then the row runs. */
function pickFromMenu(editor: BlockNoteEditor, key: string): void {
  const menu = editor.getExtension(SuggestionMenu)
  if (!menu?.shown()) throw new Error('the slash menu is not open')
  menu.closeMenu()
  menu.clearQuery()
  pick(editor, key)
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

  it('drops the space that separated the text from the slash, and only that', () => {
    const editor = mount('Intro  text')
    editor.setTextCursorPosition(editor.document[0], 'end')
    editor.getExtension(SuggestionMenu)?.addSuggestionMenu({ triggerCharacter: '/' })
    typeKeys(editor, ' /h2')

    pickFromMenu(editor, 'heading_2')

    expect(editor.document).toHaveLength(1)
    expect(editor.document[0].type).toBe('heading')
    expect(text(editor, 0)).toBe('Intro  text')
  })

  it('on an empty line converts it as before', () => {
    const editor = mount('Intro')
    editor.insertBlocks([{ type: 'paragraph' }], editor.document[0], 'after')
    editor.setTextCursorPosition(editor.document[1], 'end')

    pick(editor, 'quote')

    expect(editor.document.map((block) => block.type)).toEqual(['paragraph', 'quote'])
  })
})

describe.each([
  ['a note on a Y.Doc', true],
  ['an editor with no Y.Doc', false]
])('undo of a slash conversion, in %s', (_, live) => {
  it('puts the line back as it was before the slash, and redo turns it again', () => {
    const editor = mount('- Milk', live)
    editor.setTextCursorPosition(editor.document[0], 'end')
    editor.getExtension(SuggestionMenu)?.addSuggestionMenu({ triggerCharacter: '/' })
    // One burst of typing, picked at once: the slash and its query join the
    // same undo step as the space before them.
    typeKeys(editor, ' /h2')

    pickFromMenu(editor, 'heading_2')
    expect(editor.document[0].type).toBe('heading')
    expect(text(editor, 0)).toBe('Milk')

    editor.undo()
    expect(editor.document).toHaveLength(1)
    expect(editor.document[0].type).toBe('bulletListItem')
    expect(text(editor, 0)).toBe('Milk')

    editor.redo()
    expect(editor.document[0].type).toBe('heading')
    expect(editor.document[0].props).toMatchObject({ level: 2 })
    expect(text(editor, 0)).toBe('Milk')
  })
})
