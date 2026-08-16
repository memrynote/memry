import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEditorMenuCommand, isEditorMenuCommand, runHistoryMenuCommand } from './menu-commands'

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

  it('offers every heading level the editor supports, 1 through 6', () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const block = { id: `h${level}` }
      const editor = makeEditor(block)
      expect(applyEditorMenuCommand(editor, `format.heading${level}`)).toBe(true)
      expect(editor.updateBlock).toHaveBeenCalledWith(block, {
        type: 'heading',
        props: { level }
      })
    }
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

describe('runHistoryMenuCommand', () => {
  const originalExecCommand = document.execCommand

  function makeHistoryEditor() {
    const domElement = document.createElement('div')
    const inner = document.createElement('span')
    inner.tabIndex = 0
    domElement.appendChild(inner)
    document.body.appendChild(domElement)

    const editor = { undo: vi.fn(), redo: vi.fn(), domElement }
    ;(window as unknown as { __memryEditor?: unknown }).__memryEditor = editor
    return { editor, focusInside: () => inner.focus() }
  }

  afterEach(() => {
    delete (window as unknown as { __memryEditor?: unknown }).__memryEditor
    document.body.innerHTML = ''
    document.execCommand = originalExecCommand
    vi.restoreAllMocks()
  })

  it('routes undo/redo to the editor history while focus is inside it', () => {
    const { editor, focusInside } = makeHistoryEditor()
    focusInside()

    runHistoryMenuCommand('undo')
    expect(editor.undo).toHaveBeenCalledTimes(1)

    runHistoryMenuCommand('redo')
    expect(editor.redo).toHaveBeenCalledTimes(1)
  })

  it('does not touch the editor history when focus is outside it', () => {
    const { editor } = makeHistoryEditor()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    runHistoryMenuCommand('undo')
    expect(editor.undo).not.toHaveBeenCalled()
  })

  it('routes other contenteditable surfaces to the native command', () => {
    const { editor } = makeHistoryEditor()
    const execCommand = vi.fn()
    document.execCommand = execCommand

    const composer = document.createElement('div')
    composer.contentEditable = 'true'
    composer.tabIndex = 0
    document.body.appendChild(composer)
    composer.focus()
    Object.defineProperty(composer, 'isContentEditable', { value: true })

    runHistoryMenuCommand('undo')
    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(editor.undo).not.toHaveBeenCalled()
  })

  it('keeps native undo for focused input fields', () => {
    const { editor } = makeHistoryEditor()
    const execCommand = vi.fn()
    document.execCommand = execCommand

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    runHistoryMenuCommand('undo')
    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(editor.undo).not.toHaveBeenCalled()
  })

  it('keeps native undo for focused textareas', () => {
    const execCommand = vi.fn()
    document.execCommand = execCommand

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()

    runHistoryMenuCommand('redo')
    expect(execCommand).toHaveBeenCalledWith('redo')
  })

  it('does nothing without an editor', () => {
    expect(() => runHistoryMenuCommand('undo')).not.toThrow()
  })

  it('swallows editor errors instead of crashing the menu', () => {
    const { editor, focusInside } = makeHistoryEditor()
    editor.undo.mockImplementation(() => {
      throw new Error('not ready')
    })
    focusInside()

    expect(() => runHistoryMenuCommand('undo')).not.toThrow()
  })
})
