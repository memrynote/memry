/**
 * The editor's `inlineImage` — same node as main's, plus display-time URL
 * resolution (#1640).
 *
 * ## Why the element starts out holding the raw ref
 *
 * BlockNote calls `render` for two jobs. One is the live element in the editor.
 * The other is a fresh, detached element built to be SERIALIZED: inside a table
 * there is no `toExternalHTML` path at all — cell content goes through
 * ProseMirror's own DOM serializer, which builds its HTML from `render` — so
 * whatever `src` that element carries is what lands in the vault file.
 *
 * The two are indistinguishable from in here. BlockNote does pass a
 * `{ renderType }` context, but only to its own wrapper: that wrapper calls this
 * function plainly, so `this` never arrives. What separates them instead is
 * TIME. Serialization is synchronous end to end — `blocksToMarkdownLossy` builds
 * the DOM and reads its HTML with no `await` in between, and ProseMirror's
 * `serializeFragment` is synchronous too — so no promise can resolve between
 * this function returning and the bytes being taken. The ref is therefore on the
 * element from the first synchronous moment, and the resolved URL can only ever
 * reach the element the editor is showing.
 *
 * That ordering is the whole safety property, because a resolved URL is an
 * absolute path on ONE machine: writing it back would put `/Users/<someone>/…`
 * into a note that syncs to every other device. It is the `linkMention` bug
 * class (#1433) with a worse payload.
 *
 * The cost is that the first image in a note briefly requests its relative ref
 * against the renderer's own base URL and 404s, until the vault path arrives.
 * The vault path is cached per editor, so every image after the first resolves
 * in a microtask.
 */

import {
  createInlineImageSpec,
  INLINE_IMAGE_HAS_SCHEME,
  type InlineImageProps
} from '@memry/editor-schema/inline'

export { createInlineImageContent } from '@memry/editor-schema/inline'

interface FileUrlResolvingEditor {
  resolveFileUrl?: (url: string) => Promise<string>
}

export const InlineImage = createInlineImageSpec((inlineContent, _updateInlineContent, editor) => {
  const props = inlineContent.props as InlineImageProps
  const src = props.src || ''

  const dom = document.createElement('img')
  dom.className = 'inline-image'
  dom.setAttribute('src', src)
  if (props.alt) dom.setAttribute('alt', props.alt)
  // The node is an atom; dragging the raw image out of it drops a file URL into
  // whatever is underneath instead of moving the node.
  dom.setAttribute('draggable', 'false')

  const resolve = (editor as FileUrlResolvingEditor | undefined)?.resolveFileUrl
  // A ref that already carries a scheme (https:, data:, memry-file:) is what the
  // browser will load anyway — the same short-circuit the shared resolver makes.
  if (!resolve || !src || INLINE_IMAGE_HAS_SCHEME.test(src)) return { dom }

  void resolve(src)
    .then((url) => {
      if (url && url !== src) dom.setAttribute('src', url)
    })
    // Leave the ref in place: a broken image the user can see beats an empty
    // element they cannot.
    .catch(() => {})

  return { dom }
})
