/* eslint-disable @typescript-eslint/no-explicit-any */

import { type Block } from '@blocknote/core'
import { createHashTagSpec } from '@memry/editor-schema/inline'
import { getTagColors, withAlpha } from '@/components/note/tags-row/tag-colors'
import { isIconValue, parseIconName } from '@/components/note/note-title/emoji-icon-utils'
import { loadAllIcons } from '@/lib/hugeicon-renderer'

export function createHashTagInlineContent(tag: string, color: string = '', icon: string = '') {
  return {
    type: 'hashTag' as const,
    props: { tag, color, icon }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Build a HugeIcon SVG (vanilla DOM — the inline content render isn't React). */
function buildHugeIconSvg(
  data: Array<[string, Record<string, string>]>,
  colorHex: string
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '1em')
  svg.setAttribute('height', '1em')
  svg.setAttribute('fill', 'none')
  svg.style.color = colorHex
  svg.style.flexShrink = '0'
  for (const [tagName, attrs] of data) {
    const el = document.createElementNS(SVG_NS, tagName)
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
    svg.appendChild(el)
  }
  return svg
}

/** Prepend a tag's emoji/icon to its inline #tag chip. */
function prependTagIcon(dom: HTMLElement, iconValue: string, colorHex: string): void {
  if (isIconValue(iconValue)) {
    const holder = document.createElement('span')
    holder.style.display = 'inline-flex'
    holder.style.alignItems = 'center'
    // An inline-flex box baselines at its bottom edge, so the icon rides high
    // above the text — center it on the line instead.
    holder.style.verticalAlign = 'middle'
    holder.style.marginInlineEnd = '3px'
    holder.setAttribute('aria-hidden', 'true')
    dom.insertBefore(holder, dom.firstChild)
    const name = parseIconName(iconValue)
    void loadAllIcons().then((mod) => {
      const data = mod[name] as Array<[string, Record<string, string>]> | undefined
      if (data) holder.appendChild(buildHugeIconSvg(data, colorHex))
    })
  } else {
    const span = document.createElement('span')
    span.textContent = iconValue
    span.style.marginInlineEnd = '3px'
    span.setAttribute('aria-hidden', 'true')
    dom.insertBefore(span, dom.firstChild)
  }
}

// Presentation only. The config, `parse` and `toExternalHTML` — everything that
// decides what reaches the vault file — live in @memry/editor-schema, so the
// main process registers the identical node instead of deleting it.
export const HashTag = createHashTagSpec((inlineContent) => {
  const tag = inlineContent.props.tag || ''
  const colorName = inlineContent.props.color || ''
  const icon = inlineContent.props.icon || ''
  const colors = getTagColors(colorName, tag)

  const dom = document.createElement('span')
  dom.className = 'inline-hash-tag'
  dom.setAttribute('data-hash-tag', tag)
  dom.setAttribute('data-hash-tag-color', colorName)
  if (icon) dom.setAttribute('data-hash-tag-icon', icon)
  dom.setAttribute('contenteditable', 'false')
  dom.textContent = `#${tag}`
  if (icon) prependTagIcon(dom, icon, colors.text)

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
})

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
  tagIconMap?: Map<string, string>,
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

    const color = tagColorMap.get(normalizedTag) || ''
    const icon = tagIconMap?.get(normalizedTag) || ''
    segments.push(createHashTagInlineContent(tagName, color, icon))

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
  tagColorMap: Map<string, string>,
  tagIconMap?: Map<string, string>
): { content: string | Array<any>; didChange: boolean } {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithHashTags(
      content,
      noteTags,
      tagColorMap,
      tagIconMap
    )
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
        tagColorMap,
        tagIconMap
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
        tagIconMap,
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
  tagColorMap: Map<string, string>,
  tagIconMap?: Map<string, string>
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
      const normalized = normalizeInlineContentHashTags(
        block.content as any,
        noteTags,
        tagColorMap,
        tagIconMap
      )
      if (normalized.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, content: normalized.content as any }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeHashTags(
        block.children as Block[],
        noteTags,
        tagColorMap,
        tagIconMap
      )
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
  // Case preserved; deduplicated case-insensitively (first occurrence wins)
  const tagsByKey = new Map<string, string>()
  const tagPattern = new RegExp(HASH_TAG_PATTERN)

  function addTag(tag: string): void {
    const key = tag.toLowerCase()
    if (!tagsByKey.has(key)) tagsByKey.set(key, tag)
  }

  function extractFromText(text: string): void {
    tagPattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = tagPattern.exec(text)) !== null) {
      const precedingChar = match.index > 0 ? text[match.index - 1] : ''
      if (precedingChar && !/\s/.test(precedingChar)) continue
      addTag(match[1])
    }
  }

  function walkBlock(block: Block): void {
    if (block.type === 'codeBlock') return

    if (Array.isArray(block.content)) {
      for (const item of block.content as any[]) {
        if (item?.type === 'hashTag' && item.props?.tag) {
          addTag(item.props.tag as string)
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
  return Array.from(tagsByKey.values())
}
