import { useEffect, useRef } from 'react'
import { createLogger } from '@/lib/logger'
import {
  registerVaultLeaveFlush,
  useVaultWorkspaceLifecycle
} from '@/lib/vault-workspace-lifecycle'

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
 * `beforeDestroy` runs after the owner has unmounted, and whatever it reports
 * lands later still if it is async. By then every ancestor's effect cleanup has
 * run (React tears a deleted subtree down parent first), so a callback that
 * reaches the owner finds its unmount flush done and its save registry entry
 * gone. Running it synchronously in the cleanup would not change that for an
 * async flush, so owners handle a late report themselves (#1900).
 *
 * Teardown is deferred by a microtask so it can be cancelled. In development
 * StrictMode runs setup → cleanup → setup on the same fiber, and
 * `useCreateBlockNote` is a `useMemo`, so that simulated remount hands back the
 * SAME editor. Destroying it in the cleanup would kill every editing surface
 * the moment it first mounted — the view getter then throws "The editor view is
 * not available" and the note, journal, task and canvas bodies all render
 * blank. React runs the double-invoke synchronously, so a microtask lands after
 * the second setup has had its chance to cancel.
 *
 * A vault workspace kept mounted by VaultStack is the same case stretched out:
 * hiding it runs this cleanup, and showing it again runs the setup with the
 * SAME editor, but arbitrarily later and with renders in between. So while
 * the workspace is hidden the destroy is parked on its lifecycle, cancelled on
 * reveal and run when the workspace is dropped. The parked destroy skips
 * `beforeDestroy`: by then another vault is open and the save would land there.
 * The switch flushes it before main closes the vault instead
 * (`registerVaultLeaveFlush`).
 */
export function useEditorTeardown(
  editor: unknown,
  beforeDestroy?: () => void | Promise<void>
): void {
  const beforeDestroyRef = useRef(beforeDestroy)
  useEffect(() => {
    beforeDestroyRef.current = beforeDestroy
  })

  const lifecycle = useVaultWorkspaceLifecycle()
  const pendingRef = useRef<{
    editor: unknown
    cancelled: boolean
    /** Drops a destroy parked on a hidden workspace. */
    release?: () => void
  } | null>(null)

  useEffect(
    () =>
      registerVaultLeaveFlush(async () => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent -- latest-callback ref read at flush time, not a DOM ref from a parent
        await beforeDestroyRef.current?.()
      }),
    []
  )

  useEffect(() => {
    // Only a remount of the same editor is StrictMode's doing. A different
    // editor means the previous one is genuinely gone and must still be torn
    // down, so its pending teardown is left to run.
    const pending = pendingRef.current
    if (pending && pending.editor === editor) {
      pending.cancelled = true
      pending.release?.()
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

      const token: NonNullable<typeof pendingRef.current> = { editor, cancelled: false }
      pendingRef.current = token

      queueMicrotask(() => {
        if (token.cancelled) return

        if (lifecycle?.hidden) {
          const parked = (): void => {
            if (pendingRef.current === token) pendingRef.current = null
            destroy()
          }
          lifecycle.disposers.add(parked)
          token.release = () => lifecycle.disposers.delete(parked)
          return
        }

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
  }, [editor, lifecycle])
}
