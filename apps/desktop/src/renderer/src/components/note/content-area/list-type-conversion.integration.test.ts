import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import {
  canToggleListType,
  getBlocksForListConversion,
  isListTypeActive,
  toggleListType
} from './list-type-conversion'

// Issue #1206: a first-session user pasted a list and could not turn the lines
// into bullets. These run against a real mounted BlockNote editor to pin down
// what actually happens to a multi-block selection.
//
// Uses the default BlockNote schema — the custom schema's extra block specs drag
// react-pdf into jsdom and none of them are convertible anyway.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    // `mount(undefined)` was the teardown until BlockNote 0.54 gave unmounting
    // its own method; `mount` now takes a required element.
    editor.unmount()
    el.remove()
  }
})

function mountEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    initialContent: [
      { type: 'paragraph', content: 'Milk' },
      { type: 'paragraph', content: 'Eggs' },
      { type: 'paragraph', content: 'Bread' }
    ]
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

// Select exactly the three pasted lines — what a user drags over.
//
// There is no fourth block to avoid any more: BlockNote kept a real trailing
// empty paragraph in `editor.document` until the 0.51 trailing-block rewrite,
// and the affordance is not a document node now. The counts below are three
// for that reason, not because the conversion changed.
function selectPastedLines(editor: BlockNoteEditor): void {
  const blocks = editor.document
  editor.setSelection(blocks[0].id, blocks[2].id)
}

function blockTypes(editor: BlockNoteEditor): string[] {
  return editor.document.map((block) => block.type)
}

function blockText(editor: BlockNoteEditor, index: number): string {
  const content = editor.document[index].content as Array<{ text?: string }> | undefined
  return (content ?? []).map((item) => item.text ?? '').join('')
}

describe('list type conversion on a multi-block selection', () => {
  it('reports every selected block, not just the one under the cursor', () => {
    const editor = mountEditor()
    selectPastedLines(editor)

    expect(getBlocksForListConversion(editor)).toHaveLength(3)
  })

  it('turns all selected paragraphs into bullets and keeps their text', () => {
    const editor = mountEditor()
    selectPastedLines(editor)

    toggleListType(editor, 'bulletListItem')

    expect(blockTypes(editor)).toEqual([
      'bulletListItem',
      'bulletListItem',
      'bulletListItem'
    ])
    expect(blockText(editor, 0)).toBe('Milk')
    expect(blockText(editor, 2)).toBe('Bread')
  })

  it('covers numbered lists and checklists the same way', () => {
    const numbered = mountEditor()
    selectPastedLines(numbered)
    toggleListType(numbered, 'numberedListItem')
    expect(blockTypes(numbered)).toEqual([
      'numberedListItem',
      'numberedListItem',
      'numberedListItem'
    ])

    const checklist = mountEditor()
    selectPastedLines(checklist)
    toggleListType(checklist, 'checkListItem')
    expect(blockTypes(checklist)).toEqual([
      'checkListItem',
      'checkListItem',
      'checkListItem'
    ])
  })

  it('toggles a list back to paragraphs when every selected block is already it', () => {
    const editor = mountEditor()
    selectPastedLines(editor)
    toggleListType(editor, 'bulletListItem')

    selectPastedLines(editor)
    expect(isListTypeActive(editor, 'bulletListItem')).toBe(true)

    toggleListType(editor, 'bulletListItem')
    expect(blockTypes(editor)).toEqual(['paragraph', 'paragraph', 'paragraph'])
  })

  it('converts a mixed selection to the target type instead of toggling it off', () => {
    const editor = mountEditor()
    editor.updateBlock(editor.document[0], { type: 'bulletListItem' })
    selectPastedLines(editor)

    expect(isListTypeActive(editor, 'bulletListItem')).toBe(false)

    toggleListType(editor, 'bulletListItem')
    expect(blockTypes(editor)).toEqual([
      'bulletListItem',
      'bulletListItem',
      'bulletListItem'
    ])
  })

  it('falls back to the cursor block when nothing is selected', () => {
    const editor = mountEditor()
    editor.setTextCursorPosition(editor.document[1].id, 'end')

    expect(canToggleListType(editor)).toBe(true)

    toggleListType(editor, 'bulletListItem')
    expect(blockTypes(editor)).toEqual(['paragraph', 'bulletListItem', 'paragraph'])
  })

  it('leaves blocks without inline content alone', () => {
    const editor = mountEditor()
    editor.insertBlocks([{ type: 'image' }], editor.document[1].id, 'after')
    editor.setSelection(editor.document[0].id, editor.document[3].id)

    expect(getBlocksForListConversion(editor).map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph'
    ])

    toggleListType(editor, 'bulletListItem')
    expect(blockTypes(editor)).toEqual([
      'bulletListItem',
      'bulletListItem',
      'image',
      'bulletListItem'
    ])
  })
})
