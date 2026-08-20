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
    alt: { default: '' },
    /** Display width in px. `0` means "whatever the picture is", capped by CSS. */
    width: { default: 0, type: 'number' as const }
  },
  content: 'none' as const
}

export interface InlineImageProps {
  src: string
  alt: string
  width?: number | string
}

export function createInlineImageContent(src: string, alt = '', width = 0) {
  return { type: 'inlineImage' as const, props: { src, alt, width: toWidth(width) } }
}

/**
 * A width prop as a number, whatever it arrived as.
 *
 * Attributes seeded straight into the shared Y.Doc are STRINGS — that is how a
 * synced note delivers them — so a prop read back as `"300"` has to mean 300
 * here and not `NaN` twelve calls later, in a `style.width` nobody can trace.
 */
export function toWidth(value: unknown): number {
  const width = Math.round(Number(value))
  return Number.isFinite(width) && width > 0 ? width : 0
}

/**
 * Display width rides in the alt text as `name|300` — Obsidian's own `|`
 * convention, and the only carrier that survives a GFM table cell.
 *
 * Measured against the real converter, because the obvious answers do not work:
 * a markdown image has no width, `![alt](src "300")` loses the title on the way
 * through BlockNote, and a BARE `| ![a|300](x) |` splits the row in half — `|`
 * is the cell delimiter. The escape is remark's job, not ours: put `a|300` in
 * the alt attribute and `![a\|300](x.png)` is what lands on disk, byte-stable
 * across re-saves.
 *
 * Only a pure-numeric tail is claimed. Obsidian also writes `|300x200`, and
 * parsing that to a width would re-serialize it as `|300` — rewriting somebody
 * else's vault file to say something slightly different. Left alone, it stays
 * alt text and round-trips untouched.
 */
const ALT_WIDTH_SUFFIX = /^(.*)\|(\d+)$/

export function parseInlineImageAlt(raw: string): { alt: string; width: number } {
  const match = ALT_WIDTH_SUFFIX.exec(raw)
  if (!match) return { alt: raw, width: 0 }
  const width = toWidth(match[2])
  return width > 0 ? { alt: match[1], width } : { alt: raw, width: 0 }
}

export function serializeInlineImageAlt(alt: string, width: unknown): string {
  const px = toWidth(width)
  return px > 0 ? `${alt}|${px}` : alt
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

    const { alt, width } = parseInlineImageAlt(element.getAttribute('alt') || '')
    // A real `width` attribute outranks the alt convention: that is what an HTML
    // paste from the web carries, and it is a measurement rather than a guess.
    const attribute = toWidth(element.getAttribute('width'))
    return { src, alt, width: attribute > 0 ? attribute : width }
  },
  toExternalHTML: (inlineContent: { props: InlineImageProps }) => {
    const dom = document.createElement('img')
    dom.setAttribute('src', inlineContent.props.src || '')
    dom.setAttribute(
      'alt',
      serializeInlineImageAlt(inlineContent.props.alt || '', inlineContent.props.width)
    )
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
