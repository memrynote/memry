/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

import { createInlineContentSpec, type Block } from '@blocknote/core'
import { TAG_COLORS, withAlpha } from '@/components/note/tags-row/tag-colors'

export function createHashTagInlineContent(tag: string, color: string = 'stone') {
  return {
    type: 'hashTag' as const,
    props: { tag, color }
  }
}

export const HashTag = createInlineContentSpec(
  {
    type: 'hashTag' as const,
    propSchema: {
      tag: { default: '' },
      color: { default: 'stone' }
    },
    content: 'none'
  },
  {
    render: (inlineContent) => {
      const tag = inlineContent.props.tag || ''
      const colorName = inlineContent.props.color || 'stone'
      const colors = TAG_COLORS[colorName] || TAG_COLORS.stone

      const dom = document.createElement('span')
      dom.className = 'inline-hash-tag'
      dom.setAttribute('data-hash-tag', tag)
      dom.setAttribute('data-hash-tag-color', colorName)
      dom.setAttribute('contenteditable', 'false')
      dom.textContent = `#${tag}`

      dom.style.backgroundColor = withAlpha(colors.text, 0.12)
      dom.style.setProperty('--hash-tag-color', colors.text)
      dom.style.padding = '1px 8px'
      dom.style.borderRadius = '10px'
      dom.style.fontSize = '0.9em'
      dom.style.fontWeight = '500'
      dom.style.cursor = 'pointer'
      dom.style.whiteSpace = 'nowrap'
      dom.style.display = 'inline'
      dom.style.margin = '0 1px'
      dom.style.userSelect = 'none'
      dom.style.transition = 'opacity 150ms ease'

      return { dom }
    },
    parse: (element) => {
      if (element.hasAttribute('data-hash-tag')) {
        const tag = element.getAttribute('data-hash-tag')?.trim() || ''
        if (tag) {
          const color = element.getAttribute('data-hash-tag-color')?.trim() || 'stone'
          return { tag, color }
        }
      }
      return undefined
    },
    toExternalHTML: (inlineContent) => {
      const dom = document.createElement('span')
      dom.textContent = `#${inlineContent.props.tag || ''}`
      return { dom }
    }
  }
)

// =============================================================================
// HASH TAG TEXT SPLITTING (for normalization on load)
// =============================================================================

const HASH_TAG_PATTERN = /#([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
  return { type: 'text', text, styles }
}

function splitTextWithHashTags(
  text: string,
  noteTags: Set<string>,
  tagColorMap: Map<string, string>,
  styles?: Record<string, boolean | string>
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  const segments: Array<string | Record<string, unknown>> = []
  const pattern = new RegExp(HASH_TAG_PATTERN)
  let didChange = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    const [full, tagName] = match

    const precedingChar = match.index > 0 ? text[match.index - 1] : ''
    if (precedingChar && !/\s/.test(precedingChar)) continue

    const normalizedTag = tagName.toLowerCase()
    if (!noteTags.has(normalizedTag)) continue

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      segments.push(styles ? createStyledText(before, styles) : before)
    }

    const color = tagColorMap.get(normalizedTag) || 'stone'
    segments.push(createHashTagInlineContent(normalizedTag, color))

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

function normalizeInlineContentHashTags(
  content: string | Array<any>,
  noteTags: Set<string>,
  tagColorMap: Map<string, string>
): { content: string | Array<any>; didChange: boolean } {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithHashTags(content, noteTags, tagColorMap)
    if (!didChange) return { content, didChange: false }
    return { content: segments, didChange: true }
  }

  if (!Array.isArray(content)) return { content, didChange: false }

  let didChange = false
  const next: Array<any> = []

  for (const item of content) {
    if (typeof item === 'string') {
      const { segments, didChange: itemChanged } = splitTextWithHashTags(
        item,
        noteTags,
        tagColorMap
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
      const itemStyles = item.styles ?? {}
      const { segments, didChange: itemChanged } = splitTextWithHashTags(
        item.text ?? '',
        noteTags,
        tagColorMap,
        itemStyles
      )
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    if (item?.type === 'hashTag') {
      next.push(item)
      continue
    }

    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

export function normalizeHashTags(
  blocks: Block[],
  noteTags: Set<string>,
  tagColorMap: Map<string, string>
): { blocks: Block[]; didChange: boolean } {
  if (noteTags.size === 0) return { blocks, didChange: false }

  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('#')) return { blocks, didChange: false }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type === 'codeBlock') return block

    let blockChanged = false
    let nextBlock: Block = block

    if (block.content && (typeof block.content === 'string' || Array.isArray(block.content))) {
      const normalized = normalizeInlineContentHashTags(block.content as any, noteTags, tagColorMap)
      if (normalized.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, content: normalized.content as any }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeHashTags(block.children as Block[], noteTags, tagColorMap)
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

// =============================================================================
// INLINE TAG EXTRACTION (for syncing editor -> note tags)
// =============================================================================

export function extractInlineTags(blocks: Block[]): string[] {
  const tags = new Set<string>()
  const tagPattern = new RegExp(HASH_TAG_PATTERN)

  function extractFromText(text: string): void {
    tagPattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = tagPattern.exec(text)) !== null) {
      const precedingChar = match.index > 0 ? text[match.index - 1] : ''
      if (precedingChar && !/\s/.test(precedingChar)) continue
      tags.add(match[1].toLowerCase())
    }
  }

  function walkBlock(block: Block): void {
    if (block.type === 'codeBlock') return

    if (Array.isArray(block.content)) {
      for (const item of block.content as any[]) {
        if (item?.type === 'hashTag' && item.props?.tag) {
          tags.add((item.props.tag as string).toLowerCase())
        } else if (item?.type === 'text' && item.text) {
          extractFromText(item.text as string)
        } else if (typeof item === 'string') {
          extractFromText(item)
        }
      }
    }
    if (block.children) {
      for (const child of block.children) {
        walkBlock(child as Block)
      }
    }
  }

  for (const block of blocks) {
    walkBlock(block)
  }
  return Array.from(tags)
}
