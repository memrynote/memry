import { describe, expect, it, vi } from 'vitest'
import { applyEditorMenuCommand, isEditorMenuCommand } from './menu-commands'

function makeEditor(block: unknown = {}) {
  return {
    toggleStyles: vi.fn(),
    getTextCursorPosition: () => ({ block }),
    updateBlock: vi.fn(),
    insertBlocks: vi.fn()
  }
}

describe('applyEditorMenuCommand', () => {
  it('toggles inline styles without needing a block', () => {
    const editor = makeEditor()
    expect(applyEditorMenuCommand(editor, 'format.bold')).toBe(true)
    expect(editor.toggleStyles).toHaveBeenCalledWith({ bold: true })
  })

  it('converts the current block for headings', () => {
    const block = { id: 'b1' }
    const editor = makeEditor(block)
    expect(applyEditorMenuCommand(editor, 'format.heading1')).toBe(true)
    expect(editor.updateBlock).toHaveBeenCalledWith(block, {
      type: 'heading',
      props: { level: 1 }
    })
  })

  it('converts the current block to a bullet list', () => {
    const block = { id: 'b2' }
    const editor = makeEditor(block)
    applyEditorMenuCommand(editor, 'insert.bulletList')
    expect(editor.updateBlock).toHaveBeenCalledWith(block, { type: 'bulletListItem' })
  })

  it('inserts a fresh table block after the cursor', () => {
    const block = { id: 'b3' }
    const editor = makeEditor(block)
    expect(applyEditorMenuCommand(editor, 'insert.table')).toBe(true)
    const [blocks, ref, placement] = editor.insertBlocks.mock.calls[0]
    expect((blocks[0] as { type: string }).type).toBe('table')
    expect(ref).toBe(block)
    expect(placement).toBe('after')
  })

  it('returns false when no block is focused for a block command', () => {
    const editor = { ...makeEditor(), getTextCursorPosition: () => undefined }
    expect(applyEditorMenuCommand(editor, 'format.heading1')).toBe(false)
  })

  it('returns false for unknown commands', () => {
    const editor = makeEditor()
    expect(applyEditorMenuCommand(editor, 'file.newNote')).toBe(false)
  })

  it('classifies editor vs app commands', () => {
    expect(isEditorMenuCommand('format.heading1')).toBe(true)
    expect(isEditorMenuCommand('insert.table')).toBe(true)
    expect(isEditorMenuCommand('format.highlight')).toBe(true)
    expect(isEditorMenuCommand('file.newNote')).toBe(false)
  })
})
