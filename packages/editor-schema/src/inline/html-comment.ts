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

type Styles = Record<string, unknown>
type InlineItem = {
  type: string
  text?: string
  styles?: Styles
  props?: Styles
  content?: unknown
}
type BlockItem = { content?: unknown; children?: BlockItem[] }

function textNeighbour(items: InlineItem[], index: number, step: 1 | -1): InlineItem | undefined {
  let at = index + step
  while (items[at]?.type === 'htmlComment') at += step
  return items[at]?.type === 'text' ? items[at] : undefined
}

/**
 * The marks a comment sat inside (BBF-52). The node holds no marks, so
 * `**a <!-- b --> c**` reads back as bold `a `, the comment, bold ` c`, and the
 * serializer closed the bold before the comment and reopened it on ` c`, which
 * CommonMark does not read as bold. A mark both neighbours hold, or one a
 * neighbour holds on a whitespace edge next to the comment, is one the comment
 * was inside, since emphasis neither opens before nor closes after whitespace.
 * Never `code`: a comment inside a code span would come back as code text.
 */
function enclosingMarks(left: InlineItem | undefined, right: InlineItem | undefined): Styles {
  const leftOpen = /\s$/.test(left?.text ?? '')
  const rightOpen = /^\s/.test(right?.text ?? '')
  const marks: Styles = {}
  for (const name of new Set([
    ...Object.keys(left?.styles ?? {}),
    ...Object.keys(right?.styles ?? {})
  ])) {
    const inLeft = left?.styles?.[name] === true
    const inRight = right?.styles?.[name] === true
    if (
      name !== 'code' &&
      ((inLeft && inRight) || (inLeft && leftOpen) || (inRight && rightOpen))
    ) {
      marks[name] = true
    }
  }
  return marks
}

function sameStyles(a: Styles = {}, b: Styles = {}): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * Each comment inside marks turned into its token as a text run holding them,
 * joined to the neighbours with the same marks. The serializer writes each run
 * as its own emphasis, so a run of its own would still close the bold.
 */
function commentsInMarks(items: InlineItem[]): InlineItem[] {
  const out: InlineItem[] = []
  items.forEach((item, index) => {
    let next = item
    if (Array.isArray(item.content)) next = { ...item, content: commentsInMarks(item.content) }
    else if (item.type === 'htmlComment') {
      const marks = enclosingMarks(textNeighbour(items, index, -1), textNeighbour(items, index, 1))
      if (Object.keys(marks).length > 0) {
        next = {
          type: 'text',
          text: encodeHtmlCommentToken(String(item.props?.source ?? '')),
          styles: marks
        }
      }
    }
    const last = out.at(-1)
    if (last?.type === 'text' && next.type === 'text' && sameStyles(last.styles, next.styles)) {
      out[out.length - 1] = { ...last, text: `${last.text}${next.text}` }
    } else out.push(next)
  })
  return out
}

// A table cell is a bare inline array in the legacy shape and `{ content }` in BlockNote 0.47+.
function cellWithCommentsInMarks(cell: unknown): unknown {
  if (Array.isArray(cell)) return commentsInMarks(cell)
  const content = (cell as { content?: unknown } | null)?.content
  return Array.isArray(content) ? { ...(cell as object), content: commentsInMarks(content) } : cell
}

function blocksWithCommentsInMarks(blocks: BlockItem[]): BlockItem[] {
  return blocks.map((block) => {
    const next = { ...block }
    const table = block.content as { type?: string; rows: Array<{ cells: unknown[] }> } | undefined
    if (Array.isArray(block.content)) next.content = commentsInMarks(block.content)
    else if (table?.type === 'tableContent') {
      next.content = {
        ...table,
        rows: table.rows.map((row) => ({ ...row, cells: row.cells.map(cellWithCommentsInMarks) }))
      }
    }
    if (block.children) next.children = blocksWithCommentsInMarks(block.children)
    return next
  })
}

/**
 * Runs a blocks-to-markdown serialization of `blocks` with every comment
 * written as its token, inside the marks it sat in. The scope is synchronous:
 * whatever `serialize` exports after it returns writes nothing for the node.
 */
export function writeHtmlCommentTokens<B, T>(blocks: B[], serialize: (blocks: B[]) => T): T {
  // SAFETY: only `content` and `children` are read and replaced, with values of
  // the same shape, so every other field of `B` passes through as it was.
  const marked = blocksWithCommentsInMarks(blocks as BlockItem[]) as B[]
  markdownWrites++
  try {
    return serialize(marked)
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
