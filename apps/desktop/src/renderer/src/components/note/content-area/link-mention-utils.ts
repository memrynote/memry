/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Block } from '@blocknote/core'
import { extractDomain } from '@/lib/url-metadata'
import {
  MENTION_TOKEN_REGEX,
  parseLinkMentionToken,
  createLinkMentionContent
} from './link-mention'

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
  return { type: 'text', text, styles }
}

export function splitTextWithLinkMentions(
  text: string,
  styles?: Record<string, boolean | string>
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

function normalizeInlineContent(content: string | Array<any>): {
  content: string | Array<any>
  didChange: boolean
} {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithLinkMentions(content)
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
      const { segments, didChange: itemChanged } = splitTextWithLinkMentions(item)
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
        styles
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

function normalizeTableContent(tableContent: any): { content: any; didChange: boolean } {
  if (!tableContent?.rows) {
    return { content: tableContent, didChange: false }
  }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const normalized = normalizeInlineContent(cell)
        if (normalized.didChange) rowChanged = true
        return normalized.content
      }

      if (cell?.type === 'tableCell') {
        const normalized = normalizeInlineContent(cell.content ?? '')
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

export function normalizeLinkMentions(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  if (!JSON.stringify(blocks).includes('((mention:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type === 'codeBlock') {
      return block
    }

    let blockChanged = false
    let nextBlock: Block = block

    if (block.content) {
      if (typeof block.content === 'string' || Array.isArray(block.content)) {
        const normalized = normalizeInlineContent(block.content as any)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content as any }
        }
      } else if ((block.content as any).type === 'tableContent') {
        const normalized = normalizeTableContent(block.content)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content }
        }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeLinkMentions(block.children as Block[])
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
