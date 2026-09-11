import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import { handleEditorPaste } from './table-cell-paste'

// Issue #2081: "pasting a URL into a bulleted list and choosing URL removes the
// bullet marker", and issue #2080: the pasted link has to stay ordinary,
// editable inline content. Both live inside ProseMirror's paste pipeline, so
// these run against a real mounted BlockNote editor and a real clipboard
// payload — a mocked editor would report success either way.
//
// Uses the default BlockNote schema: it carries the list and table blocks, and
// the custom schema's extra specs drag react-pdf into jsdom.

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  readonly files: unknown[] = []

  setData(type: string, value: string): void {
    this.store.set(type, value)
  }

  getData(type: string): string {
    return this.store.get(type) ?? ''
  }

  get types(): string[] {
    return [...this.store.keys()]
  }
}

beforeEach(() => {
  if ((globalThis as any).ClipboardEvent) return
  class StubClipboardEvent extends Event {
    clipboardData = new FakeDataTransfer()
  }
  ;(globalThis as any).ClipboardEvent = StubClipboardEvent
})

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

const URL = 'https://example.com/a/b?c=1'

function mountEditor(initialContent: any[]): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    pasteHandler: handleEditorPaste,
    initialContent
  }) as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function view(editor: BlockNoteEditor): any {
  return (editor as any).prosemirrorView
}

function findText(editor: BlockNoteEditor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  view(editor).state.doc.descendants((node: any, pos: number) => {
    if (found || !node.isText || node.text !== needle) return
    found = { from: pos, to: pos + needle.length }
  })
  if (!found) throw new Error(`no text node reads "${needle}"`)
  return found
}

/** Put the caret between the two halves of a "beforeafter" run of text. */
function placeCursorInside(editor: BlockNoteEditor, text: string, offset: number): void {
  const { from } = findText(editor, text)
  const v = view(editor)
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from + offset)))
}

/**
 * A browser puts both flavours on the clipboard when a link is copied from a
 * page. The `text/html` one is what the default handler prefers for a bare URL
 * (it carries no markdown syntax), and parsing that `<a>` yields a whole
 * paragraph *block* — which is what used to replace the list item.
 */
function paste(editor: BlockNoteEditor, text: string, html?: string): void {
  const data = new FakeDataTransfer()
  data.setData('text/plain', text)
  if (html !== undefined) data.setData('text/html', html)
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  view(editor).dom.dispatchEvent(event)
}

/** Flattens a block's inline content into `text` runs and `<link href>` markers. */
function inlineShape(block: any): string {
  return (block.content ?? [])
    .map((inline: any) => (inline.type === 'link' ? `<link ${inline.href}>` : (inline.text ?? '')))
    .join('')
}

/**
 * BlockNote always keeps one trailing empty paragraph, so "the paste created no
 * block of its own" means: nothing beyond the original blocks carries content.
 */
function extraBlockCount(editor: BlockNoteEditor, originalBlocks: number): number {
  return (editor.document as any[])
    .slice(originalBlocks)
    .filter((block) => block.type !== 'paragraph' || (block.content ?? []).length > 0).length
}

function firstTableCell(editor: BlockNoteEditor): any {
  const table = editor.document.find((b) => b.type === 'table') as any
  return table.content.rows[1].cells[0]
}

describe('pasting a bare URL', () => {
  it('keeps a bulleted list item a bulleted list item', () => {
    const editor = mountEditor([{ type: 'bulletListItem', content: 'beforeafter' }])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const [block] = editor.document as any[]
    expect(block.type).toBe('bulletListItem')
    expect(inlineShape(block)).toBe(`before<link ${URL}>after`)
    expect(extraBlockCount(editor, 1)).toBe(0)
  })

  it('keeps an empty bulleted list item a bulleted list item', () => {
    const editor = mountEditor([
      { type: 'bulletListItem', content: 'first' },
      { type: 'bulletListItem', content: '' }
    ])
    editor.setTextCursorPosition((editor.document as any[])[1], 'end')

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const blocks = editor.document as any[]
    expect(blocks[1].type).toBe('bulletListItem')
    expect(inlineShape(blocks[1])).toBe(`<link ${URL}>`)
  })

  it('keeps a numbered list item numbered', () => {
    const editor = mountEditor([{ type: 'numberedListItem', content: 'beforeafter' }])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const [block] = editor.document as any[]
    expect(block.type).toBe('numberedListItem')
    expect(inlineShape(block)).toBe(`before<link ${URL}>after`)
  })

  it('keeps a nested list item nested under its parent', () => {
    const editor = mountEditor([
      {
        type: 'bulletListItem',
        content: 'parent',
        children: [{ type: 'bulletListItem', content: 'beforeafter' }]
      }
    ])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const [parent] = editor.document as any[]
    expect(parent.type).toBe('bulletListItem')
    expect(parent.children).toHaveLength(1)
    const child = parent.children[0]
    expect(child.type).toBe('bulletListItem')
    expect(inlineShape(child)).toBe(`before<link ${URL}>after`)
  })

  it('keeps the rest of a table intact when pasted into a cell', () => {
    const editor = mountEditor([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          headerRows: 1,
          rows: [{ cells: ['Task', 'Owner'] }, { cells: ['beforeafter', 'Kaan'] }]
        }
      }
    ])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const table = editor.document.find((b) => b.type === 'table') as any
    expect(table.content.rows).toHaveLength(2)
    expect(inlineShape(firstTableCell(editor))).toBe(`before<link ${URL}>after`)
    expect(extraBlockCount(editor, 1)).toBe(0)
  })

  it('inserts one inline link into a paragraph rather than a new block', () => {
    const editor = mountEditor([{ type: 'paragraph', content: 'beforeafter' }])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    expect(extraBlockCount(editor, 1)).toBe(0)
    const [block] = editor.document as any[]
    expect(block.type).toBe('paragraph')
    expect(inlineShape(block)).toBe(`before<link ${URL}>after`)
    // Exactly one URL, no duplicated raw text next to the link.
    expect((block.content as any[]).filter((i) => i.type === 'link')).toHaveLength(1)
  })

  it('leaves the pasted link as editable inline content', () => {
    const editor = mountEditor([{ type: 'bulletListItem', content: 'beforeafter' }])
    placeCursorInside(editor, 'beforeafter', 'before'.length)
    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const link = (editor.document as any[])[0].content.find((i: any) => i.type === 'link')
    // A link carries real text children, so the caret can sit inside it and a
    // selection can cover part of it — it is not an atomic chip.
    expect(link.content).toEqual([{ type: 'text', text: URL, styles: {} }])

    // The caret sits after the link: typing continues the line, it does not
    // replace or delete the link.
    editor.insertInlineContent('!')
    expect(inlineShape((editor.document as any[])[0])).toBe(`before<link ${URL}>!after`)
  })

  it('replaces the selected text instead of leaving it next to the link', () => {
    const editor = mountEditor([{ type: 'bulletListItem', content: 'beforeoldafter' }])
    const { from } = findText(editor, 'beforeoldafter')
    const v = view(editor)
    v.dispatch(
      v.state.tr.setSelection(
        TextSelection.create(v.state.doc, from + 'before'.length, from + 'beforeold'.length)
      )
    )

    paste(editor, URL, `<a href="${URL}">${URL}</a>`)

    const [block] = editor.document as any[]
    expect(block.type).toBe('bulletListItem')
    expect(inlineShape(block)).toBe(`before<link ${URL}>after`)
  })

  it('leaves plain text that is not a bare URL to the default handler', () => {
    const editor = mountEditor([{ type: 'bulletListItem', content: 'beforeafter' }])
    placeCursorInside(editor, 'beforeafter', 'before'.length)

    paste(editor, 'see https://example.com for more')

    const [block] = editor.document as any[]
    expect(block.type).toBe('bulletListItem')
    // The default handler's own autolinking, untouched by this fix.
    expect(inlineShape(block)).toBe('beforesee <link https://example.com> for moreafter')
  })
})
