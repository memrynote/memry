import type { BlockNoteEditor } from '@blocknote/core'
import type { EditorView } from '@tiptap/pm/view'

type TiptapLike = { view?: EditorView; editorView?: EditorView }

type TiptapHost = {
  _tiptapEditor?: TiptapLike
  prosemirrorView?: EditorView
}

/**
 * The real ProseMirror view, or `undefined` while there isn't one.
 *
 * TipTap 3.x `editor.view` is a Proxy that is ALWAYS truthy. With no mounted
 * view behind it, it answers `state`, `composing`, `dragging`, `editable` with
 * stubs, answers `isDestroyed` with `false`, and THROWS on everything else
 * ("The editor view is not available"). So both halves of the obvious guard,
 * `if (!view || view.isDestroyed)`, are dead code and the next line crashes.
 * `BlockNoteEditor.prosemirrorView` forwards to the same Proxy and types itself
 * non-optional, so TypeScript won't flag it either.
 *
 * The hole is open before mount AND after `unmount()`/`destroy()` — teardown
 * nulls the view while the tiptap editor and its listeners stay alive, so
 * ResizeObserver and `update`/`selectionUpdate` callbacks still fire (issue
 * #541). `editorView` is the real, nullable field; it is the only honest check.
 */
export function getLiveTiptapView(tiptap: TiptapLike | null | undefined): EditorView | undefined {
  if (!tiptap?.editorView) return undefined
  return tiptap.view
}

export function getLiveProseMirrorView(
  editor: BlockNoteEditor | null | undefined
): EditorView | undefined {
  const host = editor as unknown as TiptapHost | null | undefined
  const tiptap = host?._tiptapEditor
  if (tiptap) return getLiveTiptapView(tiptap)
  return host?.prosemirrorView
}
