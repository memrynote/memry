/**
 * The editor flavour of `htmlComment` (AF-015): a small muted marker where
 * the comment sits, never the comment's text.
 *
 * Config and `toExternalHTML` come from @memry/editor-schema, so the main
 * process registers the identical node and writes the same bytes. Only the
 * node view differs, gated on `renderType === 'nodeView'` as in
 * `inline-checkbox.ts`: BlockNote reaches this function with `renderType:
 * 'dom'` when it serializes a table cell, and that path must write what
 * `toExternalHTML` writes.
 */

import { getI18n } from 'react-i18next'
import {
  createHtmlCommentMarkerDOM,
  createHtmlCommentSpec,
  createHtmlCommentExternalDOM,
  isPercentComment
} from '@memry/editor-schema/inline'

export function renderHtmlComment(
  this: { renderType?: string } | undefined,
  inlineContent: { props: { source: string } }
): { dom: HTMLElement } {
  if (this?.renderType !== 'nodeView') {
    return { dom: createHtmlCommentExternalDOM(inlineContent.props.source) }
  }
  const { source } = inlineContent.props
  const t = getI18n().getFixedT(null, 'notes')
  return {
    dom: createHtmlCommentMarkerDOM(
      t(isPercentComment(source) ? 'editor.content.percentComment' : 'editor.content.htmlComment'),
      source
    )
  }
}

export const HtmlComment = createHtmlCommentSpec(renderHtmlComment)
