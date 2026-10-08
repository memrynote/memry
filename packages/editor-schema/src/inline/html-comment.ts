/**
 * `htmlComment` inline content spec — an HTML comment kept in the document
 * (AF-015).
 *
 * BlockNote has no node for `<!-- … -->`, so its markdown parser dropped every
 * comment, and a hand edit next to one, or a house-style write-back, wrote the
 * note without it. Notes keep hidden wiki links in comments, so the links went
 * with them.
 *
 * `source` is the comment's whole text, `<!--` and `-->` included, exactly as
 * the file holds it. It is inline rather than a block because a comment glued
 * to a line of text (directly under the line someone edits, say) has to stay
 * glued: a paragraph that holds only this node writes back as the comment's
 * own line, and one that holds text and the node writes back as both, on the
 * lines they were on.
 *
 * On disk the node is its token (`@memry/shared/html-comments`), which
 * `normalizeSerializedMarkdown` turns back into `source`. The serializer never
 * sees the comment itself, so nothing it escapes or re-breaks can reach it.
 *
 * Older builds have no spec for this node. Their write-back finds it with
 * `findUnrepresentableNodes` and keeps the file as it is.
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'
import type { CustomInlineContentImplementation } from '@blocknote/core'
import { encodeHtmlCommentToken } from '@memry/shared/html-comments'

export const htmlCommentConfig = {
  type: 'htmlComment' as const,
  propSchema: {
    source: { default: '' }
  },
  content: 'none' as const
}

export function createHtmlCommentContent(source: string) {
  return { type: 'htmlComment' as const, props: { source } }
}

/** The node's on-disk form: its token, which the serializer passes through untouched. */
export function createHtmlCommentTokenDOM(source: string): HTMLSpanElement {
  const dom = document.createElement('span')
  dom.className = 'html-comment'
  dom.textContent = encodeHtmlCommentToken(source)
  return dom
}

/**
 * What the editor shows: a small marker, not the comment's text. `label` is
 * the surface's own name for it, read by screen readers.
 */
export function createHtmlCommentMarkerDOM(label: string): HTMLSpanElement {
  const dom = document.createElement('span')
  dom.className = 'html-comment-marker'
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('role', 'img')
  dom.setAttribute('aria-label', label)
  dom.setAttribute('title', label)
  dom.textContent = '<!---->'
  return dom
}

type HtmlCommentRender = CustomInlineContentImplementation<
  typeof htmlCommentConfig,
  never
>['render']

/** Everything that decides the node's on-disk form. Shared by every surface. */
export const htmlCommentSerialization = {
  toExternalHTML: (inlineContent: { props: { source: string } }) => ({
    dom: createHtmlCommentTokenDOM(inlineContent.props.source)
  })
}

export function createHtmlCommentSpec(
  render: HtmlCommentRender
): InlineContentSpec<typeof htmlCommentConfig> {
  return createInlineContentSpec(htmlCommentConfig, {
    render,
    ...htmlCommentSerialization
  })
}
