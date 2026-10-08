/**
 * The editor flavour of `htmlComment` (AF-015): a small muted marker where
 * the comment sits, never the comment's text.
 *
 * Config and `toExternalHTML` come from @memry/editor-schema, so the main
 * process registers the identical node and writes the same bytes. Only the
 * node view differs, gated on `renderType === 'nodeView'` as in
 * `inline-checkbox.ts`: BlockNote reaches this function with `renderType:
 * 'dom'` when it serializes a table cell, and that path must get the token.
 */

import { getI18n } from 'react-i18next'
import {
  createHtmlCommentMarkerDOM,
  createHtmlCommentSpec,
  createHtmlCommentTokenDOM
} from '@memry/editor-schema/inline'

export function renderHtmlComment(
  this: { renderType?: string } | undefined,
  inlineContent: { props: { source: string } }
): { dom: HTMLElement } {
  if (this?.renderType !== 'nodeView') {
    return { dom: createHtmlCommentTokenDOM(inlineContent.props.source) }
  }
  return {
    dom: createHtmlCommentMarkerDOM(
      getI18n().getFixedT(null, 'notes')('editor.content.htmlComment')
    )
  }
}

export const HtmlComment = createHtmlCommentSpec(renderHtmlComment)
