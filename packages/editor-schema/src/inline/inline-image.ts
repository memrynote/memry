/**
 * `inlineImage` inline content spec (#1640).
 *
 * BlockNote's `image` is a BLOCK, and a `tableCell` holds inline content only —
 * so an image could not exist in a table cell at all, and an image glued to the
 * end of a paragraph was dropped on parse rather than kept. GFM says the same
 * thing about the file on disk: a table cell may hold phrasing content only, and
 * `![alt](src)` is phrasing. So the fix is a node with exactly that shape.
 *
 * Lives here rather than in the renderer because the main process needs the same
 * node: a spec the main-process schema does not carry is not a rendering gap, it
 * is data loss — y-prosemirror deletes any element it cannot build straight out
 * of the shared Y.Doc (#1435).
 *
 * ## Compat
 *
 * Purely additive. No existing document holds an `inlineImage`, and nothing that
 * used to become an `image` block still does — see `parse` below, which hands
 * every image the block rule used to claim straight back to it. A build without
 * this spec meeting a document that has one is the ordinary missing-spec case
 * the parity gate exists to prevent, which is why both processes register it in
 * the same commit.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'

export const inlineImageConfig = {
  type: 'inlineImage' as const,
  propSchema: {
    /**
     * Exactly the string that sits between `](` and `)` on disk — usually a
     * note-relative ref like `../attachments/<noteId>/x.png`. It is NEVER the
     * resolved `memry-file://` URL: that carries this machine's vault path, and
     * writing it back would put an absolute local path in the vault file. The
     * renderer resolves for display only (see the renderer's `inline-image.ts`).
     */
    src: { default: '' },
    alt: { default: '' }
  },
  content: 'none' as const
}

type InlineImageRender = CustomInlineContentImplementation<
  typeof inlineImageConfig,
  never
>['render']

export interface InlineImageProps {
  src: string
  alt: string
}

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows. Mirrors the resolver. */
export const INLINE_IMAGE_HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/**
 * The parents an `image` BLOCK can actually replace.
 *
 * `![x](y)` on its own line arrives as `<p><img></p>`, and a `<p>` is a block
 * BlockNote is free to turn into an image block — that is what it has always
 * done, and what every image in every existing note relies on.
 *
 * Everything else in an HTML document that can hold an `<img>` — a heading, a
 * tight list item, a table cell — is inline-only in BlockNote's schema, so the
 * block rule cannot take those. Before this spec they had no node at all and the
 * image was dropped on parse.
 */
const BLOCK_IMAGE_PARENT_TAGS = new Set(['P', 'DIV', 'FIGURE', 'SECTION', 'ARTICLE', 'BODY'])

/**
 * Containers whose BlockNote node holds INLINE CONTENT ONLY, so no block can
 * live inside them however the HTML is nested.
 *
 * `- ![x](y)` and `> ![x](y)` reach the parser as `<li><p><img></p></li>` and
 * `<blockquote><p><img></p></blockquote>`: the `<img>` IS alone in a `<p>`, so
 * the immediate-parent test alone would hand it to the image block — which the
 * list item and the quote then cannot hold. Measured before this node existed:
 * the quote came back as a bare `>` with the image gone, and the bullet was
 * rewritten into Memry's nesting-marker form on every open. Inline content is
 * what both of them can actually carry.
 */
const INLINE_ONLY_ANCESTOR_TAGS = new Set([
  'LI',
  'BLOCKQUOTE',
  'TD',
  'TH',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6'
])

/**
 * Whether this `<img>` is the standalone block image BlockNote already handles.
 *
 * This is the line between the two nodes, and it is drawn so that nothing that
 * used to become an `image` block stops becoming one: same parent, same "there
 * is nothing else in here" test. An `<img>` with something beside it, or one in
 * a parent that can only hold inline content, is the case that had no node.
 */
function isStandaloneBlockImage(img: HTMLElement): boolean {
  // A `<figure>` is the image block's caption form, and BlockNote parses the
  // figure rather than the `<img>` inside it — an `<img>` next to a
  // `<figcaption>` would otherwise read as "not alone in its parent" and be
  // claimed here, costing the caption. Declined exactly as its own parse does.
  if (img.closest('figure')) return true

  const parent = img.parentElement
  // No parent to compare against (a bare fragment): treat it as standalone and
  // leave it to the block rule, which is what happens today.
  if (!parent) return true
  if (!BLOCK_IMAGE_PARENT_TAGS.has(parent.tagName)) return false

  for (const node of Array.from(parent.childNodes)) {
    if (node === img) continue
    if (node.nodeType === 3 /* text */) {
      if ((node.textContent ?? '').trim() !== '') return false
      continue
    }
    if (node.nodeType === 1 /* element */) return false
  }

  for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (INLINE_ONLY_ANCESTOR_TAGS.has(ancestor.tagName)) return false
  }
  return true
}

/** Everything that decides the node's on-disk form. Shared by both processes. */
export const inlineImageSerialization = {
  /**
   * Runs as a `tag: '*'` rule — BlockNote gives custom inline content no way to
   * scope it — so the tag check is first and cheap: this is called for every
   * element in every pasted or parsed document.
   *
   * Returning `undefined` makes ProseMirror skip this rule and keep looking,
   * which is exactly how a standalone image still becomes an `image` block.
   */
  parse: (element: HTMLElement) => {
    if (element.tagName !== 'IMG') return undefined
    // `getAttribute`, never `element.src`: the property resolves a relative ref
    // against the document's base URL, which would bake this machine's path
    // into the note.
    const src = element.getAttribute('src')?.trim() || ''
    if (!src) return undefined
    if (isStandaloneBlockImage(element)) return undefined
    return { src, alt: element.getAttribute('alt')?.trim() || '' }
  },
  toExternalHTML: (inlineContent: { props: InlineImageProps }) => {
    const dom = document.createElement('img')
    dom.setAttribute('src', inlineContent.props.src || '')
    // Omitted when empty so the markdown reads `![](src)` rather than growing an
    // `alt=""` that rehype-remark would have to invent a value for.
    if (inlineContent.props.alt) dom.setAttribute('alt', inlineContent.props.alt)
    return { dom }
  }
}

export function createInlineImageSpec(
  render: InlineImageRender
): InlineContentSpec<typeof inlineImageConfig> {
  return createInlineContentSpec(inlineImageConfig, {
    render,
    ...inlineImageSerialization,
    /**
     * Both this spec and the `image` BLOCK parse with a `tag: '*'` rule, so the
     * only thing separating them is order — and without this, block specs are
     * built first and `image` claims every `<img>` there is. In a paragraph or a
     * table cell that block has nowhere to go, so ProseMirror drops it: the
     * exact silent loss this node exists to end.
     *
     * Running first is safe because `parse` declines every image `image` used to
     * take (see `isStandaloneBlockImage`); a rule that declines is skipped and
     * the block rule is reached exactly as before.
     */
    runsBefore: ['image']
  })
}

export function createInlineImageContent(src: string, alt = '') {
  return {
    type: 'inlineImage' as const,
    props: { src, alt }
  }
}
