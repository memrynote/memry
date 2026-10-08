/**
 * `htmlComment` inline content spec — an HTML comment kept in the document
 * (AF-015).
 *
 * BlockNote has no node for `<!-- … -->`, so its markdown parser dropped every
 * comment, and a hand edit next to one, or a house-style write-back, wrote the
 * note without it. Notes keep hidden wiki links in comments, so the links went
 * with them.
 *
 * `source` is the comment's whole text, `<!--` and `-->` (or an Obsidian
 * comment's `%%` pair, BBF-26) included, exactly as the file holds it. It is
 * inline rather than a block because a comment glued to a line of text
 * (directly under the line someone edits, say) has to stay glued: a paragraph
 * that holds only this node writes back as the comment's own line, and one
 * that holds text and the node writes back as both, on the lines they were on.
 *
 * On disk the node is its token (`@memry/shared/html-comments`), which
 * `normalizeSerializedMarkdown` turns back into `source`. The serializer never
 * sees the comment itself, so nothing it escapes or re-breaks can reach it.
 * The token exists only inside `writeHtmlCommentTokens`. Every other export,
 * the clipboard's HTML and plain text included, writes nothing for the node,
 * so a token never reaches another app (BBF-31).
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

let markdownWrites = 0

/**
 * Runs a blocks-to-markdown serialization with every comment written as its
 * token. The scope is synchronous: whatever `serialize` exports after it
 * returns writes nothing for the node.
 */
export function writeHtmlCommentTokens<T>(serialize: () => T): T {
  markdownWrites++
  try {
    return serialize()
  } finally {
    markdownWrites--
  }
}

/** The node outside the editor: its token while Memry writes markdown, empty anywhere else. */
export function createHtmlCommentExternalDOM(source: string): HTMLSpanElement {
  const dom = document.createElement('span')
  dom.className = 'html-comment'
  if (markdownWrites > 0) dom.textContent = encodeHtmlCommentToken(source)
  return dom
}

export function isPercentComment(source: string): boolean {
  return source.startsWith('%%')
}

/**
 * What the editor shows: a small marker, not the comment's text. The marker is
 * the comment's form left empty. `label` is the surface's own name for it,
 * read by screen readers.
 */
export function createHtmlCommentMarkerDOM(label: string, source: string): HTMLSpanElement {
  const dom = document.createElement('span')
  dom.className = 'html-comment-marker'
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('role', 'img')
  dom.setAttribute('aria-label', label)
  dom.setAttribute('title', label)
  dom.textContent = isPercentComment(source) ? '%%%%' : '<!---->'
  return dom
}

type HtmlCommentRender = CustomInlineContentImplementation<
  typeof htmlCommentConfig,
  never
>['render']

/** Everything that decides the node's on-disk form. Shared by every surface. */
export const htmlCommentSerialization = {
  toExternalHTML: (inlineContent: { props: { source: string } }) => ({
    dom: createHtmlCommentExternalDOM(inlineContent.props.source)
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
