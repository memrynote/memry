import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { rearmUndoManager } from './register-editor-plugin'

const TRACKED = 'local'

function makeDoc(): { doc: Y.Doc; text: Y.Text; undoManager: Y.UndoManager } {
  const doc = new Y.Doc()
  const text = doc.getText('body')
  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([TRACKED]) })
  return { doc, text, undoManager }
}

function type(doc: Y.Doc, text: Y.Text, value: string): void {
  doc.transact(() => text.insert(text.length, value), TRACKED)
}

describe('rearmUndoManager', () => {
  it('brings a destroyed manager back to capturing and undoing', () => {
    const { doc, text, undoManager } = makeDoc()

    // What ProseMirror's plugin-view teardown does on every `registerPlugin`.
    undoManager.destroy()
    type(doc, text, 'after destroy')
    expect(undoManager.undoStack).toHaveLength(0)

    expect(rearmUndoManager(undoManager)).toBe(true)

    type(doc, text, ' and more')
    expect(undoManager.undoStack).toHaveLength(1)

    undoManager.undo()
    expect(text.toString()).toBe('after destroy')
  })

  it('captures a live manager exactly once, so re-arming twice is safe', () => {
    const { doc, text, undoManager } = makeDoc()

    rearmUndoManager(undoManager)
    rearmUndoManager(undoManager)

    type(doc, text, 'one')
    expect(undoManager.undoStack).toHaveLength(1)

    undoManager.undo()
    expect(text.toString()).toBe('')
  })

  it('restores the manager to its own tracked origins so redo is captured', () => {
    const { doc, text, undoManager } = makeDoc()
    undoManager.destroy()
    rearmUndoManager(undoManager)

    type(doc, text, 'hello')
    undoManager.undo()
    expect(text.toString()).toBe('')

    undoManager.redo()
    expect(text.toString()).toBe('hello')
  })

  it('reports nothing to do when there is no manager', () => {
    expect(rearmUndoManager(undefined)).toBe(false)
  })
})
