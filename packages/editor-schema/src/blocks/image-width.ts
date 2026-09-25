/**
 * An image block's display width, carried through the vault file.
 *
 * BlockNote's markdown serializer writes an image as `![name](url)` (or a
 * `<figure>` when it has a caption) and drops `previewWidth`, so a resize lived
 * only in the Y.Doc: the next time the doc was rebuilt from the file — an
 * external edit, a re-seed — the image came back at its natural size.
 *
 * The width rides in the alt text as `name|300`, the convention the reader
 * already uses for a cell image (`parseInlineImageAlt`) and Obsidian's own. An
 * older build reads the suffix as part of the image's name, still renders the
 * picture, and writes the same bytes back, so the width survives a round trip
 * through a version that cannot show it.
 */

import type { defaultBlockSpecs } from '@blocknote/core'
import { parseInlineImageAlt, serializeInlineImageAlt, toWidth } from '../inline/inline-image'

/**
 * The width every image is inserted at (paste, drop, the attachment picker).
 *
 * Never written to disk. Every image already in a Y.Doc carries it, so writing
 * it would rewrite every existing note that holds an image on its next save —
 * a vault-wide diff for a value nobody chose. The cost is one width: an image
 * dragged to exactly this many px reads back at its natural size, which is
 * what every image did before widths were persisted at all.
 */
export const DEFAULT_IMAGE_PREVIEW_WIDTH = 600

type ImageBlockSpec = typeof defaultBlockSpecs.image

/** The alt text an image block is written with: its name, plus a chosen width. */
export function serializeImageBlockAlt(name: string, previewWidth: unknown): string {
  const width = toWidth(previewWidth)
  return serializeInlineImageAlt(name, width === DEFAULT_IMAGE_PREVIEW_WIDTH ? 0 : width)
}

export function withImageWidthInAlt(spec: ImageBlockSpec): ImageBlockSpec {
  const { parse, toExternalHTML } = spec.implementation
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      parse(element) {
        const props = parse?.(element)
        if (!props || typeof props.name !== 'string') return props
        const { alt, width } = parseInlineImageAlt(props.name)
        if (width === 0) return props
        // A real `width` attribute outranks the alt convention, as it does for
        // a cell image: it is what an HTML paste carries.
        const previewWidth = toWidth(props.previewWidth) > 0 ? props.previewWidth : width
        return { ...props, name: alt, previewWidth }
      },
      toExternalHTML(block, editor, context) {
        const output = toExternalHTML?.call(this, block, editor, context)
        // No `<img>` when the block has no url or shows a link instead.
        const image = output?.dom.querySelector('img')
        if (image) {
          const props = block.props as { name?: string; previewWidth?: unknown }
          image.setAttribute('alt', serializeImageBlockAlt(props.name ?? '', props.previewWidth))
        }
        return output
      }
    }
  }
}
