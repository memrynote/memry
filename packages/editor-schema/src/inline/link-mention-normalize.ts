/**
 * Turns `((mention:…))` text back into `linkMention` nodes. Shared because both
 * processes build documents from markdown: the renderer when it loads a note,
 * and main when it seeds or replaces a note's Y.Doc. Main promoting at the seed
 * is what keeps every device from promoting the same text on its own replica,
 * which merges into one chip per device (#3871).
 */
/* oxlint-disable typescript/no-explicit-any */

import type { Block } from '@blocknote/core'
import {
  MENTION_TOKEN_REGEX,
  parseLinkMentionToken,
  createLinkMentionContent,
  serializeLinkMentionToken
} from './link-mention'

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    return url
  }
}

export interface NormalizeLinkMentionsOptions {
  /**
   * Promote only a token that serializes back to its own bytes. A token an
   * older build wrote with `_ * ! ~ '` raw would come back re-encoded, which
   * rewrites the file. Main sets this, so its seed never changes a file's bytes;
   * the renderer promotes and re-encodes those few tokens once, on open.
   */
  byteNeutralOnly?: boolean
}

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
  return { type: 'text', text, styles }
}

export function splitTextWithLinkMentions(
  text: string,
  styles?: Record<string, boolean | string>,
  options: NormalizeLinkMentionsOptions = {}
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  const pattern = new RegExp(MENTION_TOKEN_REGEX)
  const segments: Array<string | Record<string, unknown>> = []
  let didChange = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const [full, encoded] = match
    const url = parseLinkMentionToken(encoded)
    if (!url) continue
    if (options.byteNeutralOnly && serializeLinkMentionToken(url) !== full) continue

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) segments.push(styles ? createStyledText(before, styles) : before)
    }

    segments.push(createLinkMentionContent(url, extractDomain(url)))
    didChange = true
    lastIndex = match.index + full.length
  }

  if (!didChange) {
    return { segments: [styles ? createStyledText(text, styles) : text], didChange: false }
  }

  const trailing = text.slice(lastIndex)
  if (trailing) segments.push(styles ? createStyledText(trailing, styles) : trailing)

  return { segments, didChange: true }
}

function normalizeInlineContent(
  content: string | Array<any>,
  options: NormalizeLinkMentionsOptions
): {
  content: string | Array<any>
  didChange: boolean
} {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithLinkMentions(content, undefined, options)
    if (!didChange) return { content, didChange: false }
    return { content: segments, didChange: true }
  }

  if (!Array.isArray(content)) {
    return { content, didChange: false }
  }

  let didChange = false
  const next: Array<any> = []

  for (const item of content) {
    if (typeof item === 'string') {
      const { segments, didChange: itemChanged } = splitTextWithLinkMentions(
        item,
        undefined,
        options
      )
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    if (item?.type === 'text') {
      const styles = item.styles ?? {}
      const { segments, didChange: itemChanged } = splitTextWithLinkMentions(
        item.text ?? '',
        styles,
        options
      )
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

function normalizeTableContent(
  tableContent: any,
  options: NormalizeLinkMentionsOptions
): { content: any; didChange: boolean } {
  if (!tableContent?.rows) {
    return { content: tableContent, didChange: false }
  }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const normalized = normalizeInlineContent(cell, options)
        if (normalized.didChange) rowChanged = true
        return normalized.content
      }

      if (cell?.type === 'tableCell') {
        const normalized = normalizeInlineContent(cell.content ?? '', options)
        if (normalized.didChange) {
          rowChanged = true
          return { ...cell, content: normalized.content }
        }
      }

      return cell
    })

    if (rowChanged) {
      didChange = true
      return { ...row, cells }
    }
    return row
  })

  if (!didChange) {
    return { content: tableContent, didChange: false }
  }

  return { content: { ...tableContent, rows }, didChange: true }
}

export function normalizeLinkMentions(
  blocks: Block[],
  options: NormalizeLinkMentionsOptions = {}
): { blocks: Block[]; didChange: boolean } {
  if (!JSON.stringify(blocks).includes('((mention:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    let blockChanged = false
    let nextBlock: Block = block

    // A code block's own text is literal; blocks nested under it are not code.
    if (block.content && block.type !== 'codeBlock') {
      if (typeof block.content === 'string' || Array.isArray(block.content)) {
        const normalized = normalizeInlineContent(block.content, options)
        if (normalized.didChange) {
          blockChanged = true
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Block.content is typed per block type; the normalizer returns the same content kind it was given
          nextBlock = { ...nextBlock, content: normalized.content } as Block
        }
      } else if (block.content.type === 'tableContent') {
        const normalized = normalizeTableContent(block.content, options)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content }
        }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeLinkMentions(block.children, options)
      if (normalizedChildren.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, children: normalizedChildren.blocks }
      }
    }

    if (blockChanged) didChange = true

    return blockChanged ? nextBlock : block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
}
