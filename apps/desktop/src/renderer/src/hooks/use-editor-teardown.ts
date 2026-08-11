import { useEffect, useRef } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:EditorTeardown')

interface TiptapHost {
  _tiptapEditor?: { destroy?: () => void }
}

/**
 * Explicitly tear a BlockNote editor down when its owner unmounts.
 *
 * `useCreateBlockNote` is a bare `useMemo` with no cleanup: it builds a
 * `BlockNoteEditor` and parks the underlying Tiptap instance on
 * `window.ProseMirror`, and nothing ever releases either. `BlockNoteView`'s ref
 * callback calls `editor.unmount()`, which destroys the ProseMirror *view* but
 * deliberately keeps the Tiptap editor reusable — every listener registered on
 * it stays attached. `_tiptapEditor.destroy()` is `unmount()` +
 * `removeAllListeners()`, and its `unmount()` is guarded on `editorView`, so
 * calling it after BlockNoteView already unmounted the view is a no-op there.
 *
 * `beforeDestroy` runs first and may return a promise: teardown waits for it so
 * a pending save can still read the document while the editor is intact. It is
 * awaited even when it rejects — a failed save must not strand the editor.
 *
 * Teardown is deferred by a microtask so it can be cancelled. In development
 * StrictMode runs setup → cleanup → setup on the same fiber, and
 * `useCreateBlockNote` is a `useMemo`, so that simulated remount hands back the
 * SAME editor. Destroying it in the cleanup would kill every editing surface
 * the moment it first mounted — the view getter then throws "The editor view is
 * not available" and the note, journal, task and canvas bodies all render
 * blank. React runs the double-invoke synchronously, so a microtask lands after
 * the second setup has had its chance to cancel.
 */
export function useEditorTeardown(
  editor: unknown,
  beforeDestroy?: () => void | Promise<void>
): void {
  const beforeDestroyRef = useRef(beforeDestroy)
  useEffect(() => {
    beforeDestroyRef.current = beforeDestroy
  })

  const pendingRef = useRef<{ editor: unknown; cancelled: boolean } | null>(null)

  useEffect(() => {
    // Only a remount of the same editor is StrictMode's doing. A different
    // editor means the previous one is genuinely gone and must still be torn
    // down, so its pending teardown is left to run.
    const pending = pendingRef.current
    if (pending && pending.editor === editor) {
      pending.cancelled = true
      pendingRef.current = null
    }

    return () => {
      const tiptap = (editor as TiptapHost | null)?._tiptapEditor
      const destroy = (): void => {
        try {
          tiptap?.destroy?.()
        } catch (error) {
          log.warn('Failed to destroy editor on unmount', error)
        }
        const globalHandle = window as unknown as { ProseMirror?: unknown }
        if (tiptap && globalHandle.ProseMirror === tiptap) {
          delete globalHandle.ProseMirror
        }
      }

      const token = { editor, cancelled: false }
      pendingRef.current = token

      queueMicrotask(() => {
        if (token.cancelled) return
        if (pendingRef.current === token) pendingRef.current = null

        let flushed: void | Promise<void> = undefined
        try {
          flushed = beforeDestroyRef.current?.()
        } catch (error) {
          log.warn('Editor teardown flush threw', error)
        }

        if (flushed && typeof flushed.then === 'function') {
          void flushed.then(destroy, (error: unknown) => {
            log.warn('Editor teardown flush rejected', error)
            destroy()
          })
          return
        }
        destroy()
      })
    }
  }, [editor])
}
