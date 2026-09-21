import type { BlockNoteEditorOptions } from '@blocknote/core'
import { withCollaboration } from '@blocknote/core/yjs'
import type * as Y from 'yjs'

/**
 * Adds the Yjs collaboration extensions to a set of editor options when the
 * note has a live local Y.Doc, and returns them untouched when it does not.
 *
 * This exists because of how BlockNote 0.52 moved Yjs out of `@blocknote/core`.
 * Up to 0.51, `collaboration: { fragment, user }` was a field on
 * `BlockNoteEditorOptions` and the editor installed the Y extensions itself.
 * From 0.52 the field is gone and `withCollaboration` is the only thing that
 * installs them.
 *
 * The dangerous part is that removing the field does not produce a type error.
 * Both `BlockNoteEditor.create` and `useCreateBlockNote` infer their argument
 * into a generic `Options extends Partial<BlockNoteEditorOptions<…>>`, and an
 * object with extra properties still satisfies that constraint, so excess
 * property checking never runs. A stale `collaboration` key compiles, and is
 * then silently dropped: the editor comes up with no ySync plugin, keystrokes
 * never become Y updates, and the next remote update or note reload replaces
 * the buffer with the unchanged doc. For a synced vault that is silent data
 * loss, which is why the binding is asserted in
 * `collaboration-options.test.ts` rather than trusted to the compiler.
 *
 * Kept as one expression, not two `useCreateBlockNote` call sites: the editor
 * is constructed once, so the fragment has to be present at construction or
 * the binding can never attach.
 */
export function withCollaborationIfLive<
  // `any` mirrors BlockNote's own signature for these three schema generics;
  // narrowing them here would stop a custom schema's options from matching.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Options extends Partial<BlockNoteEditorOptions<any, any, any>>
>(fragment: Y.XmlFragment | undefined, options: Options): Options {
  if (!fragment) return options
  return withCollaboration<Options>({
    ...options,
    collaboration: {
      fragment,
      // Single-user, local-first: no remote cursors are ever drawn, but the
      // field is required, so it carries the local identity and nothing else.
      user: { name: 'Local User', color: '#3b82f6' }
    }
  })
}
