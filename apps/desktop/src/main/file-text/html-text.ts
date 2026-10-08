/**
 * The text a reader sees in an HTML block (#1872): what search indexes and the
 * link scan reads for the note that embeds it. The file itself is never
 * changed and its scripts never run here.
 */

import { normalizeExtractedText } from '../database/queries/extracted-text'

/** Never rendered as text. */
const HIDDEN_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/**
 * Inline code, written out as a markdown code span (and `pre` as a fenced
 * block) so the link scan skips it the way it skips code in a note's markdown
 * (AF-006). Search still reads the words.
 */
const INLINE_CODE_ELEMENTS = new Set(['CODE', 'KBD', 'SAMP'])

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
      if (name === 'PRE') {
        out.push(codeBlock(codeText(item as Element)))
        continue
      }
      if (INLINE_CODE_ELEMENTS.has(name)) {
        out.push(codeSpan(codeText(item as Element)))
        continue
      }
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

/** The text of a code element, line breaks kept, hidden elements left out. */
function codeText(element: Element): string {
  const parts: string[] = []
  const stack: Node[] = [element]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.nodeValue ?? '')
      continue
    }
    if (node.nodeType !== ELEMENT_NODE) continue
    const name = (node as Element).tagName
    if (HIDDEN_ELEMENTS.has(name)) continue
    if (name === 'BR') parts.push('\n')
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child)
  }
  return parts.join('')
}

function longestBacktickRun(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return longest
}

/** One line of inline code, as an HTML renderer collapses its whitespace. */
function codeSpan(text: string): string {
  const content = text.replace(/\s+/g, ' ').trim()
  if (!content) return ''
  const ticks = '`'.repeat(longestBacktickRun(content) + 1)
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${content}${pad}${ticks}`
}

/** A fenced block, its fence longer than any backtick run inside it. */
function codeBlock(text: string): string {
  const content = text.replace(/^\n+|\n+$/g, '')
  if (!content.trim()) return ''
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1))
  return `\n\n${fence}\n${content}\n${fence}\n\n`
}
