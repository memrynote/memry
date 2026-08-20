/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The editor flavour of `inlineImage` — presentation only.
 *
 * The config, `parse` and `toExternalHTML` — everything that decides what
 * reaches the vault file — live in @memry/editor-schema, so the main process
 * registers the identical node instead of deleting it out of the shared Y.Doc.
 *
 * What is added here is the one thing main must NOT do: resolving a
 * note-relative `src` (`../attachments/<noteId>/x.png`) to something the
 * renderer can actually load. That resolution is display-only and is gated on
 * `renderType === 'nodeView'` for a reason — BlockNote reaches the same `render`
 * with `renderType: 'dom'` when it serializes a table cell, and an `<img src>`
 * carrying this machine's absolute vault path is exactly what must never be
 * written back to disk.
 */

import { createInlineImageSpec } from '@memry/editor-schema/inline'

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows. Mirrors the resolver. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/**
 * Exported for its own test. BlockNote wraps whatever is handed to
 * `createInlineImageSpec`, and the wrapper calls it without a `this`, so the
 * `nodeView` branch below is only reachable through the real editor — or
 * through this reference.
 */
export function renderInlineImage(this: any, inlineContent: any, _update: unknown, editor: any) {
  const src = String(inlineContent.props.src || '')
  const alt = String(inlineContent.props.alt || '')

  const dom = document.createElement('img')
  dom.className = 'inline-image'
  // The on-disk value goes on first and unconditionally: the serializer reads
  // this element, so whatever is on it at that moment is what lands in markdown.
  dom.setAttribute('src', src)
  dom.setAttribute('alt', alt)
  dom.setAttribute('draggable', 'false')
  dom.contentEditable = 'false'

  const resolve = editor?.resolveFileUrl
  if (this?.renderType === 'nodeView' && src && !HAS_SCHEME.test(src) && resolve) {
    void Promise.resolve(resolve(src))
      .then((resolved: string) => {
        if (resolved) dom.setAttribute('src', resolved)
      })
      .catch(() => {
        /* leave the unresolved ref in place — a broken image is honest here */
      })
  }

  return { dom }
}

export const InlineImage = createInlineImageSpec(renderInlineImage)
