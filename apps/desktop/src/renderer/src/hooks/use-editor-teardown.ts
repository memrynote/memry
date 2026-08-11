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
 */
export function useEditorTeardown(
  editor: unknown,
  beforeDestroy?: () => void | Promise<void>
): void {
  const beforeDestroyRef = useRef(beforeDestroy)
  useEffect(() => {
    beforeDestroyRef.current = beforeDestroy
  })

  useEffect(() => {
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

      let pending: void | Promise<void> = undefined
      try {
        pending = beforeDestroyRef.current?.()
      } catch (error) {
        log.warn('Editor teardown flush threw', error)
      }

      if (pending && typeof pending.then === 'function') {
        void pending.then(destroy, (error: unknown) => {
          log.warn('Editor teardown flush rejected', error)
          destroy()
        })
        return
      }
      destroy()
    }
  }, [editor])
}
