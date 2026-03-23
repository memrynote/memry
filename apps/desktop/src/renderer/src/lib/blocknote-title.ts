import type { Block } from '@blocknote/core'

export const TITLE_MAX_LENGTH = 200

interface TextItem {
  type: 'text'
  text: string
}

interface LinkItem {
  type: 'link'
  content: TextItem[]
}

type InlineItem = TextItem | LinkItem

function extractTextFromInlineContent(items: InlineItem[]): string {
  let result = ''
  for (const item of items) {
    if (item.type === 'text') {
      result += item.text
    } else if (item.type === 'link' && Array.isArray(item.content)) {
      for (const child of item.content) {
        result += child.text
      }
    }
  }
  return result
}

export function extractTitleFromBlocks(blocks: Block[]): string {
  if (blocks.length === 0) return ''

  const firstBlock = blocks[0]
  const { content } = firstBlock

  if (!Array.isArray(content)) return ''

  const raw = extractTextFromInlineContent(content as InlineItem[])
  const trimmed = raw.trim()

  if (trimmed.length === 0) return ''

  return trimmed.slice(0, TITLE_MAX_LENGTH)
}
