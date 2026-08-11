import { renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorTeardown } from './use-editor-teardown'

/** Teardown is deferred by a microtask so StrictMode can cancel it. */
const settleTeardown = (): Promise<void> => Promise.resolve()

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
  it('destroys the editor on unmount and drops its registered listeners', async () => {
    const { editor, tiptap, listeners } = createEditor()
    tiptap.on('update', () => {})
    const win = window as unknown as { ProseMirror?: unknown }
    win.ProseMirror = tiptap

    const { unmount } = renderHook(() => useEditorTeardown(editor))
    expect(tiptap.destroy).not.toHaveBeenCalled()

    unmount()
    await settleTeardown()

    expect(tiptap.destroy).toHaveBeenCalledTimes(1)
    expect(tiptap.isDestroyed).toBe(true)
    expect(listeners.size).toBe(0)
    expect(win.ProseMirror).toBeUndefined()
  })

  it('keeps a window handle that belongs to a different editor', async () => {
    const { editor } = createEditor()
    const other = createEditor()
    const win = window as unknown as { ProseMirror?: unknown }
    win.ProseMirror = other.tiptap

    const { unmount } = renderHook(() => useEditorTeardown(editor))
    unmount()
    await settleTeardown()

    expect(win.ProseMirror).toBe(other.tiptap)
  })

  it('survives the StrictMode double effect that remounts the same editor', async () => {
    const { editor, tiptap } = createEditor()
    const flush = vi.fn()

    // StrictMode runs setup → cleanup → setup on the same fiber. `useMemo`
    // hands the same editor back, so destroying it here blanks every editing
    // surface for the rest of the session.
    const { unmount } = renderHook(() => useEditorTeardown(editor, flush), {
      wrapper: StrictMode
    })
    await settleTeardown()

    expect(tiptap.destroy).not.toHaveBeenCalled()
    expect(tiptap.isDestroyed).toBe(false)
    expect(flush).not.toHaveBeenCalled()

    unmount()
    await settleTeardown()

    expect(tiptap.destroy).toHaveBeenCalledTimes(1)
  })

  it('still tears the previous editor down when the editor identity changes', async () => {
    const first = createEditor()
    const second = createEditor()

    const { rerender, unmount } = renderHook(({ editor }) => useEditorTeardown(editor), {
      initialProps: { editor: first.editor as unknown }
    })

    rerender({ editor: second.editor as unknown })
    await settleTeardown()

    expect(first.tiptap.destroy).toHaveBeenCalledTimes(1)
    expect(second.tiptap.destroy).not.toHaveBeenCalled()

    unmount()
    await settleTeardown()

    expect(second.tiptap.destroy).toHaveBeenCalledTimes(1)
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
    await settleTeardown()

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
