import { yUndoPluginKey } from 'y-prosemirror'
import type { Plugin } from '@tiptap/pm/state'
import type * as Y from 'yjs'

/**
 * Registering a ProseMirror plugin on a live editor kills collaborative undo.
 *
 * ProseMirror rebuilds every plugin VIEW whenever `state.plugins` changes
 * identity, which `registerPlugin` / `unregisterPlugin` both do, and
 * y-prosemirror's yUndo view destroys the shared `Y.UndoManager` on teardown.
 * `reconfigure` keeps plugin STATE, so the view created in its place hands back
 * that same, already-destroyed manager: it is off the doc's `afterTransaction`
 * and out of its own `trackedOrigins`, so nothing is captured again and Ctrl+Z
 * is a silent no-op for the rest of the session — on every surface, because the
 * manager belongs to the note's Y.Doc, not to the plugin.
 *
 * Re-arming is the exact inverse of `UndoManager.destroy()`. The replacement
 * view re-adds its own `stack-item-*` listeners to the same instance, so those
 * are not ours to restore.
 */
export function rearmUndoManager(undoManager: Y.UndoManager | undefined): boolean {
  const handler = (undoManager as UndoManagerInternals | undefined)?.afterTransactionHandler
  if (!undoManager || !handler) return false

  undoManager.trackedOrigins.add(undoManager)
  // `off` first: a manager that was never destroyed must not end up with the
  // handler registered twice, which would double every stack item.
  undoManager.doc.off('afterTransaction', handler)
  undoManager.doc.on('afterTransaction', handler)
  return true
}

/** The one private field we depend on — see `rearmUndoManager`. */
interface UndoManagerInternals {
  afterTransactionHandler?: (transaction: Y.Transaction) => void
}

interface TiptapEditorLike {
  state?: unknown
  registerPlugin?: (
    plugin: Plugin,
    handlePlugins?: (plugin: Plugin, plugins: Plugin[]) => Plugin[]
  ) => void
  unregisterPlugin?: (nameOrPluginKey: unknown) => void
}

function getTiptapEditor(editor: unknown): TiptapEditorLike | undefined {
  const tiptap = (editor as { _tiptapEditor?: TiptapEditorLike } | undefined)?._tiptapEditor
  if (!tiptap?.registerPlugin || !tiptap?.unregisterPlugin) return undefined
  return tiptap
}

function rearmEditorUndoManager(tiptap: TiptapEditorLike): void {
  const state = tiptap.state
  if (!state) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rearmUndoManager(yUndoPluginKey.getState(state as any)?.undoManager)
}

/**
 * Register a ProseMirror plugin on a mounted BlockNote editor and return the
 * matching cleanup, with collaborative undo kept alive across both halves.
 *
 * Returns `undefined` when the editor has no tiptap instance to register on, so
 * callers can `return` it straight out of an effect.
 */
export function registerEditorPlugin(
  editor: unknown,
  plugin: Plugin,
  handlePlugins?: (plugin: Plugin, plugins: Plugin[]) => Plugin[]
): (() => void) | undefined {
  const tiptap = getTiptapEditor(editor)
  if (!tiptap) return undefined

  // Passed through positionally rather than as an explicit `undefined`, so the
  // call reaching tiptap is byte-identical to the hand-written ones this
  // replaced (its default arg appends; some callers must prepend instead).
  if (handlePlugins) tiptap.registerPlugin?.(plugin, handlePlugins)
  else tiptap.registerPlugin?.(plugin)
  rearmEditorUndoManager(tiptap)

  return () => {
    tiptap.unregisterPlugin?.(plugin.spec.key)
    rearmEditorUndoManager(tiptap)
  }
}
