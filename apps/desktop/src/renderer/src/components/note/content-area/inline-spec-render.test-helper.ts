import { BlockNoteEditor, BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core'

/**
 * Call a custom inline spec's `render` the way BlockNote calls it.
 *
 * Until BlockNote 0.50 a spec's `implementation.render` was the function the
 * spec was built with, so a test could hand it a props object and read the DOM
 * back. 0.51 wraps it: the wrapper first rebuilds the ProseMirror node from the
 * inline content so it can pass it to the implementation, and that needs a real
 * `editor.pmSchema` — reached through `pmSchema.cached.blockNoteEditor`, which
 * only a constructed editor has. Called without one it throws on `pmSchema`
 * or `cached` before any of our code runs.
 *
 * The editor is built on a schema holding the defaults plus the one spec under
 * test, rather than the app's full `editorSchema`: these are unit tests of one
 * spec's presentation, and the full schema drags react-pdf into jsdom.
 */
export function renderInlineSpec<Spec>(
  type: string,
  spec: Spec,
  inlineContent: { type?: string; props: Record<string, unknown> },
  updateInlineContent: () => void = () => undefined,
  // Real editor options, for a spec whose render reads one off the editor —
  // `resolveFileUrl` is the only such case today.
  editorOptions: Record<string, unknown> = {}
): { dom: HTMLElement; contentDOM?: HTMLElement } {
  const schema = BlockNoteSchema.create({
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      [type]: spec
    } as never
  })
  const editor = BlockNoteEditor.create({ schema, ...editorOptions } as never)

  // SAFETY: every spec built by `createInlineContentSpec` carries this
  // `implementation.render`; the parameter is generic only so callers keep
  // their own spec type at the call site.
  return (
    spec as unknown as {
      implementation: {
        render: (
          content: unknown,
          update: () => void,
          editor: unknown
        ) => { dom: HTMLElement; contentDOM?: HTMLElement }
      }
    }
  ).implementation.render({ type, ...inlineContent }, updateInlineContent, editor)
}
