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
import {
  restoreEmphasisRuns,
  tokenizeEmphasisRuns,
  type Span,
  type InlineItem
} from './emphasis-runs'

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
 * CommonMark does not read as bold. A mark a neighbour holds on a whitespace
 * edge next to the comment is one the comment was inside, since emphasis
 * neither opens before nor closes after whitespace. Without such an edge the
 * runs read back the same whether the comment sat inside or between them
 * (`**a**<!-- b -->**c**`), and the serializer already writes valid emphasis.
 * A hard break is not such an edge: the run before it holds the `\n` even when
 * the emphasis closed before the break (`**a**  \n<!-- b --> c`).
 * Never `code`: a comment inside a code span would come back as code text.
 */
function enclosingMarks(left: InlineItem | undefined, right: InlineItem | undefined): Styles {
  const marks: Styles = {}
  for (const [side, open] of [
    [left, /[^\S\n]$/.test(left?.text ?? '')],
    [right, /^[^\S\n]/.test(right?.text ?? '')]
  ] as const) {
    if (!open) continue
    for (const [name, on] of Object.entries(side?.styles ?? {})) {
      if (on === true && name !== 'code') marks[name] = true
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

type Inline = (items: InlineItem[]) => InlineItem[]

// A table cell is a bare inline array in the legacy shape and `{ content }` in BlockNote 0.47+.
function mapCell(cell: unknown, inline: Inline): unknown {
  if (Array.isArray(cell)) return inline(cell)
  const content = (cell as { content?: unknown } | null)?.content
  return Array.isArray(content) ? { ...(cell as object), content: inline(content) } : cell
}

function mapInline(blocks: BlockItem[], inline: Inline): BlockItem[] {
  return blocks.map((block) => {
    const next = { ...block }
    const table = block.content as { type?: string; rows: Array<{ cells: unknown[] }> } | undefined
    if (Array.isArray(block.content)) next.content = inline(block.content)
    else if (table?.type === 'tableContent') {
      next.content = {
        ...table,
        rows: table.rows.map((row) => ({ ...row, cells: row.cells.map((c) => mapCell(c, inline)) }))
      }
    }
    if (block.children) next.children = mapInline(block.children, inline)
    return next
  })
}

/**
 * Runs a blocks-to-markdown serialization of `blocks` with every comment
 * written as its token, inside the marks it sat in, and each run of emphasis
 * written as one span. The scope is synchronous: whatever
 * `serialize` exports after it returns writes nothing for the node.
 */
export function writeHtmlCommentTokens<B>(blocks: B[], serialize: (blocks: B[]) => string): string
export function writeHtmlCommentTokens<B>(
  blocks: B[],
  serialize: (blocks: B[]) => Promise<string>
): Promise<string>
export function writeHtmlCommentTokens<B>(
  blocks: B[],
  serialize: (blocks: B[]) => string | Promise<string>
): string | Promise<string> {
  const marks: Span[] = []
  // SAFETY: only `content` and `children` are read and replaced, with values of
  // the same shape, so every other field of `B` passes through as it was.
  const marked = mapInline(blocks as BlockItem[], (items) =>
    tokenizeEmphasisRuns(commentsInMarks(items), marks)
  ) as B[]
  const restore = (markdown: string): string => restoreEmphasisRuns(markdown, marks)
  markdownWrites++
  try {
    const out = serialize(marked)
    return typeof out === 'string' ? restore(out) : out.then(restore)
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
