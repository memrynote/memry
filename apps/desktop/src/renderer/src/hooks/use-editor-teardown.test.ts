import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorTeardown } from './use-editor-teardown'

function createEditor() {
  const listeners = new Map<string, Set<() => void>>()
  const tiptap = {
    isDestroyed: false,
    on(event: string, handler: () => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
    },
    destroy: vi.fn(() => {
      tiptap.isDestroyed = true
      listeners.clear()
    })
  }
  return { editor: { _tiptapEditor: tiptap }, tiptap, listeners }
}

afterEach(() => {
  delete (window as unknown as { ProseMirror?: unknown }).ProseMirror
})

describe('useEditorTeardown', () => {
  it('destroys the editor on unmount and drops its registered listeners', () => {
    const { editor, tiptap, listeners } = createEditor()
    tiptap.on('update', () => {})
    const win = window as unknown as { ProseMirror?: unknown }
    win.ProseMirror = tiptap

    const { unmount } = renderHook(() => useEditorTeardown(editor))
    expect(tiptap.destroy).not.toHaveBeenCalled()

    unmount()

    expect(tiptap.destroy).toHaveBeenCalledTimes(1)
    expect(tiptap.isDestroyed).toBe(true)
    expect(listeners.size).toBe(0)
    expect(win.ProseMirror).toBeUndefined()
  })

  it('keeps a window handle that belongs to a different editor', () => {
    const { editor } = createEditor()
    const other = createEditor()
    const win = window as unknown as { ProseMirror?: unknown }
    win.ProseMirror = other.tiptap

    const { unmount } = renderHook(() => useEditorTeardown(editor))
    unmount()

    expect(win.ProseMirror).toBe(other.tiptap)
  })

  it('waits for an async flush before destroying, and destroys even if it rejects', async () => {
    const { editor, tiptap } = createEditor()
    const order: string[] = []
    let resolveFlush: (() => void) | null = null
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFlush = () => {
            order.push('flush')
            resolve()
          }
        })
    )

    const { unmount } = renderHook(() => useEditorTeardown(editor, flush))
    unmount()

    expect(flush).toHaveBeenCalledTimes(1)
    expect(tiptap.destroy).not.toHaveBeenCalled()

    resolveFlush!()
    await vi.waitFor(() => expect(tiptap.destroy).toHaveBeenCalledTimes(1))
    order.push('destroy')
    expect(order).toEqual(['flush', 'destroy'])

    const rejecting = createEditor()
    const { unmount: unmountRejecting } = renderHook(() =>
      useEditorTeardown(rejecting.editor, () => Promise.reject(new Error('save failed')))
    )
    unmountRejecting()
    await vi.waitFor(() => expect(rejecting.tiptap.destroy).toHaveBeenCalledTimes(1))
  })

  it('does nothing when there is no editor', () => {
    const { unmount } = renderHook(() => useEditorTeardown(null))
    expect(() => unmount()).not.toThrow()
  })
})
