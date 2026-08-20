/**
 * `inlineImage` inline content spec — an image that lives INSIDE a line of text.
 *
 * BlockNote's own `image` is a block, and a `tableCell` holds inline content
 * only, so a table cell could never hold a picture: the markdown round-trip
 * dropped it on parse (`| ![a](x.png) |` came back `|  |`) and nothing in the
 * editor could author one. That is the gap #1640 reports.
 *
 * The on-disk form is plain CommonMark `![alt](src)`, which GFM allows inside a
 * table cell — so this adds a node type, not a file format. What makes that work
 * both ways is the DOM: `render`/`toExternalHTML` emit a real `<img>`, which
 * BlockNote's HTML→markdown step writes as `![alt](src)`, and remark's
 * markdown→HTML step hands back as `<img>` for `parse` to claim.
 *
 * ## Why `parse` only claims images inside a cell
 *
 * BlockNote's `image` block parses `<img>` too. Both rules are `tag: "*"` +
 * `getAttrs`, so the FIRST one that matches wins and the loser never runs.
 * Claiming every `<img>` here would turn standalone images — every image in
 * every note today — into inline ones; leaving the block spec to win would keep
 * the cell case broken, because ProseMirror cannot place a block inside
 * `inline*` content and simply drops it (that IS today's bug).
 *
 * So the two are separated by context rather than by priority alone: this spec
 * claims an `<img>` only when it sits in a `td`/`th`, where a block image is
 * impossible anyway, and `runsBefore: ['image']` is what guarantees it is asked
 * first — BlockNote turns `runsBefore` into the TipTap priority that orders
 * ProseMirror's parse rules (see BlockNoteSchema's `init`).
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'

export const inlineImageConfig = {
  type: 'inlineImage' as const,
  propSchema: {
    src: { default: '' },
    alt: { default: '' }
  },
  content: 'none' as const
}

export interface InlineImageProps {
  src: string
  alt: string
}

export function createInlineImageContent(src: string, alt = '') {
  return { type: 'inlineImage' as const, props: { src, alt } }
}

type InlineImageRender = CustomInlineContentImplementation<
  typeof inlineImageConfig,
  never
>['render']

/**
 * A cell is the only place an inline image is the right answer. Everywhere else
 * an `<img>` is a block image, and claiming it here would silently convert every
 * existing note's images on their next load.
 */
function isInsideTableCell(element: HTMLElement): boolean {
  return element.closest('td, th') !== null
}

/** Everything that decides the node's on-disk form. Shared by both processes. */
export const inlineImageSerialization = {
  parse: (element: HTMLElement) => {
    if (element.tagName !== 'IMG' || !isInsideTableCell(element)) return undefined
    // `getAttribute`, never `.src`: the property resolves a note-relative ref
    // (`../attachments/<id>/x.png`) against the renderer's base URL, and writing
    // THAT back to disk is how a vault stops being portable between machines.
    const src = element.getAttribute('src')?.trim() || ''
    if (!src) return undefined
    return { src, alt: element.getAttribute('alt') || '' }
  },
  toExternalHTML: (inlineContent: { props: InlineImageProps }) => {
    const dom = document.createElement('img')
    dom.setAttribute('src', inlineContent.props.src || '')
    dom.setAttribute('alt', inlineContent.props.alt || '')
    return { dom }
  }
}

export function createInlineImageSpec(
  render: InlineImageRender
): InlineContentSpec<typeof inlineImageConfig> {
  return createInlineContentSpec(inlineImageConfig, {
    render,
    ...inlineImageSerialization,
    // Asked before BlockNote's `image` block, which parses `<img>` as well.
    // Without this the block rule matches first and the cell image is dropped.
    runsBefore: ['image']
  })
}
