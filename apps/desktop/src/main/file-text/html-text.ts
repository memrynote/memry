/**
 * The text a reader sees in an HTML block (#1872): what search indexes and the
 * link scan reads for the note that embeds it. The file itself is never
 * changed and its scripts never run here.
 */

import { normalizeExtractedText } from '../database/queries/extracted-text'

/** Never rendered as text. */
const HIDDEN_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/** Elements that start a new paragraph, so their words never run together. */
const BLOCK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'CAPTION',
  'DD',
  'DETAILS',
  'DIALOG',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL'
])

const ELEMENT_NODE = 1
const TEXT_NODE = 3

export async function readHtmlText(html: string): Promise<string> {
  // Lazy so jsdom stays out of the startup set; see import/_shared/lazy-jsdom.ts.
  const { JSDOM } = await import('../import/_shared/lazy-jsdom')
  const dom = new JSDOM(html)
  try {
    const out: string[] = []
    // Iterative, so a deeply nested document cannot overflow the stack.
    const stack: Array<Node | string> = [dom.window.document.documentElement]
    while (stack.length > 0) {
      const item = stack.pop()
      if (item === undefined) continue
      if (typeof item === 'string') {
        out.push(item)
        continue
      }
      if (item.nodeType === TEXT_NODE) {
        out.push(item.nodeValue ?? '')
        continue
      }
      if (item.nodeType !== ELEMENT_NODE) continue
      const name = (item as Element).tagName
      if (HIDDEN_ELEMENTS.has(name)) continue
      if (name === 'BR') {
        out.push('\n')
        continue
      }
      const block = BLOCK_ELEMENTS.has(name)
      if (block) stack.push('\n\n')
      for (let child = item.lastChild; child; child = child.previousSibling) stack.push(child)
      if (block) out.push('\n\n')
    }
    return normalizeExtractedText(out.join(''))
  } finally {
    dom.window.close()
  }
}
