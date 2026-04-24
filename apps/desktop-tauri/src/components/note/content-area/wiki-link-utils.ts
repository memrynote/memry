/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import type { Block } from '@blocknote/core'
import type { HeadingInfo } from './types'
import { createWikiLinkInlineContent } from './wiki-link'

// =============================================================================
// HEADING EXTRACTION
// =============================================================================

export function extractHeadings(blocks: Block[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let position = 0

  function processBlock(block: Block): void {
    if (block.type === 'heading') {
      const level = (block.props?.level as 1 | 2 | 3) || 1
      const text = Array.isArray(block.content)
        ? block.content
            .map((item) => {
              if (typeof item === 'string') return item
              if (item && typeof item === 'object' && 'text' in item) return item.text
              return ''
            })
            .join('')
        : ''

      if (text.trim()) {
        headings.push({
          id: block.id,
          text: text.trim(),
          level,
          position: position * 40
        })
      }
      position++
    }

    if (block.children && Array.isArray(block.children)) {
      block.children.forEach((child) => processBlock(child as Block))
    }
  }

  blocks.forEach((block) => processBlock(block))
  return headings
}

// =============================================================================
// WIKI LINK UTILITIES
// =============================================================================

export const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

export function splitWikiLinkQuery(query: string): { search: string; alias: string } {
  const [rawTarget, rawAlias] = query.split('|', 2)
  return {
    search: rawTarget?.trim() ?? '',
    alias: rawAlias?.trim() ?? ''
  }
}

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
  return { type: 'text', text, styles }
}

export function splitTextWithWikiLinks(
  text: string,
  styles?: Record<string, boolean | string>
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  const segments: Array<string | Record<string, unknown>> = []
  const pattern = new RegExp(WIKI_LINK_PATTERN)
  let didChange = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const [full, rawTarget, rawAlias] = match
    const target = rawTarget?.trim()
    const alias = rawAlias?.trim() ?? ''

    if (!target) {
      continue
    }

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) {
        segments.push(styles ? createStyledText(before, styles) : before)
      }
    }

    segments.push(createWikiLinkInlineContent(target, alias))
    didChange = true
    lastIndex = match.index + full.length
  }

  if (!didChange) {
    return { segments: [styles ? createStyledText(text, styles) : text], didChange: false }
  }

  const trailing = text.slice(lastIndex)
  if (trailing) {
    segments.push(styles ? createStyledText(trailing, styles) : trailing)
  }

  return { segments, didChange: true }
}

export function normalizeInlineContent(content: string | Array<any>): {
  content: string | Array<any>
  didChange: boolean
} {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithWikiLinks(content)
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
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item as any)
      }
      continue
    }

    if (item?.type === 'text') {
      const styles = item.styles ?? {}
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item.text ?? '', styles)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    if (item?.type === 'wikiLink') {
      next.push(item)
      continue
    }

    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

export function normalizeTableContent(tableContent: any): { content: any; didChange: boolean } {
  if (!tableContent?.rows) {
    return { content: tableContent, didChange: false }
  }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const normalized = normalizeInlineContent(cell)
        if (normalized.didChange) {
          rowChanged = true
        }
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

export function normalizeWikiLinks(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('[[')) {
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
      const normalizedChildren = normalizeWikiLinks(block.children as Block[])
      if (normalizedChildren.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, children: normalizedChildren.blocks }
      }
    }

    if (blockChanged) {
      didChange = true
    }

    return blockChanged ? nextBlock : block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
}

// =============================================================================
// MARKDOWN UTILITIES
// =============================================================================

export function normalizeMarkdownHardBreaks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    let lineBody = line
    let lineEnding = ''

    if (lineBody.endsWith('\r')) {
      lineEnding = '\r'
      lineBody = lineBody.slice(0, -1)
    }

    const trimmed = lineBody.trimStart()
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~')

    if (isFence) {
      inCodeBlock = !inCodeBlock
      normalized.push(lineBody + lineEnding)
      continue
    }

    if (!inCodeBlock) {
      const match = lineBody.match(/(\\+)$/)
      if (match && match[1].length % 2 === 1) {
        const nextLine = lineBody.slice(0, -1)
        if (nextLine.trim() === '') {
          continue
        }
        normalized.push(nextLine + lineEnding)
        continue
      }
    }

    normalized.push(lineBody + lineEnding)
  }

  return normalized.join('\n')
}
