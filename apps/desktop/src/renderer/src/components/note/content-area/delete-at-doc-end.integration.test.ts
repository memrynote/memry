import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from 'prosemirror-state'

// Regression guard for the forward-Delete RangeError seen in production
// (window_error, 2026.710.3, win32).
//
// @blocknote/core 0.47.1 ships getParentBlockInfo() without the depth guard its
// own JSDoc, type signature (`BlockInfo | undefined`) and only call site all
// promise. A TOP-LEVEL block resolves to $pos.depth === 1, so depth - 1 === 0
// and ProseMirror's ResolvedPos.before(0) throws
// "There is no position before the top-level node".
//
// Reached via: Delete -> handleDelete -> getNextBlockInfoAtAnyLevel ->
// getNextBlockInfo (undefined: last sibling) -> getParentBlockInfo (throws).
// Upstream restored the guard in 0.48.0; we carry it as a pnpm patch instead of
// taking a 6-package editor bump with a known CSS breaking change.
//
// Uses the default BlockNote schema — the custom schema's extra block specs drag
// react-pdf into jsdom and are irrelevant to block merging.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.mount(undefined)
    el.remove()
  }
})

// The Delete keymap runs through TipTap's command manager, which needs a real
// mounted view (TipTap 3.x throws on view access before mount).
async function mountEditorWithMarkdown(markdown: string): Promise<BlockNoteEditor> {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })

  const blocks = await editor.tryParseMarkdownToBlocks(markdown)
  editor.replaceBlocks(editor.document, blocks)
  return editor
}

// Puts an empty caret at the end of the text in the given top-level block.
function placeCaretAtEndOfBlock(editor: BlockNoteEditor, blockIndex: number): void {
  const tt = (editor as any)._tiptapEditor
  const block = editor.document[blockIndex]
  const pmBlock = tt.state.doc.resolve(0).node().child(0).child(blockIndex)
  expect(pmBlock.attrs.id).toBe(block.id)

  let endOfContent = -1
  tt.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'blockContainer' && node.attrs.id === block.id) {
      endOfContent = pos + node.nodeSize - 2
    }
    return true
  })
  expect(endOfContent).toBeGreaterThan(-1)

  const tr = tt.state.tr.setSelection(TextSelection.create(tt.state.doc, endOfContent))
  tt.view.dispatch(tr)
  expect(tt.state.selection.empty).toBe(true)
}

function pressDelete(editor: BlockNoteEditor): void {
  ;(editor as any)._tiptapEditor.commands.keyboardShortcut('Delete')
}

function blockText(editor: BlockNoteEditor, blockIndex: number): string {
  const content = editor.document[blockIndex]?.content as Array<{ text?: string }> | undefined
  return (content ?? []).map((c) => c.text ?? '').join('')
}

describe('forward Delete at the end of the document', () => {
  it('does not throw when the caret is at the end of the last top-level block', async () => {
    const editor = await mountEditorWithMarkdown('Hello')
    placeCaretAtEndOfBlock(editor, editor.document.length - 1)

    expect(() => pressDelete(editor)).not.toThrow()
  })

  it('leaves the document untouched when there is nothing to merge', async () => {
    const editor = await mountEditorWithMarkdown('Hello')
    placeCaretAtEndOfBlock(editor, editor.document.length - 1)
    const before = JSON.stringify(editor.document)

    pressDelete(editor)

    expect(JSON.stringify(editor.document)).toBe(before)
  })

  // Guards the fix itself: the depth guard must only short-circuit at the root,
  // never break the merge that Delete is actually supposed to perform.
  it('still merges the next block into the current one when one exists', async () => {
    // BlockNote appends a trailing empty paragraph on mount, so don't assume a
    // block count — assert on the merge itself.
    const editor = await mountEditorWithMarkdown('First\n\nSecond')
    const blockCountBefore = editor.document.length
    expect(blockText(editor, 0)).toBe('First')
    expect(blockText(editor, 1)).toBe('Second')
    placeCaretAtEndOfBlock(editor, 0)

    pressDelete(editor)

    expect(blockText(editor, 0)).toBe('FirstSecond')
    expect(editor.document.length).toBe(blockCountBefore - 1)
  })
})
