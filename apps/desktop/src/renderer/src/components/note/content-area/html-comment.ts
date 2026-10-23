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

/**
 * The section markers #1410 writes (`packages/importers/src/readwise/section.ts`).
 * Only the rendering differs: the comment's bytes stay the node's `source`.
 */
const READWISE_MARKER = /^<!--\s*(readwise|readwise-day):(start|end)(?:\s[^]*)?-->$/

const BOOK_PATH =
  'M3 3.5c2-.8 3.7-.8 5 .5v8.5c-1.3-1.3-3-1.3-5-.5zM13 3.5c-2-.8-3.7-.8-5 .5v8.5c1.3-1.3 3-1.3 5-.5z'

const READWISE_LABEL_KEYS = {
  'readwise:start': 'editor.content.readwise.noteStart',
  'readwise:end': 'editor.content.readwise.noteEnd',
  'readwise-day:start': 'editor.content.readwise.dayStart',
  'readwise-day:end': 'editor.content.readwise.dayEnd'
} as const

function createReadwiseDividerDOM(
  kind: keyof typeof READWISE_LABEL_KEYS,
  t: (key: string) => string
): HTMLElement {
  const label = t(READWISE_LABEL_KEYS[kind])
  const dom = document.createElement('span')
  dom.className = 'readwise-divider'
  dom.dataset.readwiseMarker = kind
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('role', 'separator')
  dom.setAttribute('aria-label', label)

  const band = document.createElement('span')
  band.className = 'readwise-divider-band'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'readwise-divider-icon')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', BOOK_PATH)
  svg.append(path)
  const text = document.createElement('span')
  text.textContent = label
  band.append(svg, text)
  dom.append(band)

  if (kind.endsWith(':start')) {
    const hint = document.createElement('span')
    hint.className = 'readwise-divider-hint'
    hint.textContent = t('editor.content.readwise.hint')
    dom.append(hint)
  }
  return dom
}

export function renderHtmlComment(
  this: { renderType?: string } | undefined,
  inlineContent: { props: { source: string } }
): { dom: HTMLElement } {
  if (this?.renderType !== 'nodeView') {
    return { dom: createHtmlCommentExternalDOM(inlineContent.props.source) }
  }
  const { source } = inlineContent.props
  const t = getI18n().getFixedT(null, 'notes')
  const readwise = READWISE_MARKER.exec(source)
  if (readwise) {
    return {
      dom: createReadwiseDividerDOM(
        `${readwise[1]}:${readwise[2]}` as keyof typeof READWISE_LABEL_KEYS,
        t
      )
    }
  }
  return {
    dom: createHtmlCommentMarkerDOM(
      t(isPercentComment(source) ? 'editor.content.percentComment' : 'editor.content.htmlComment'),
      source
    )
  }
}

export const HtmlComment = createHtmlCommentSpec(renderHtmlComment)
