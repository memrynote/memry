/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Block } from '@blocknote/core'
import {
  DATE_MENTION_TOKEN_REGEX,
  parseDateMentionToken,
  salvageDateMentionToken
} from '@memry/shared/date-mention'
import { createDateMentionContent } from './date-mention'

type InlineNode = { type: string; text?: string; styles?: unknown; props?: unknown }

function splitTextNode(node: InlineNode): InlineNode[] {
  if (node.type !== 'text' || typeof node.text !== 'string') return [node]
  const text = node.text
  const regex = new RegExp(DATE_MENTION_TOKEN_REGEX.source, 'g')
  const out: InlineNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const data = parseDateMentionToken(m[1]) ?? salvageDateMentionToken(m[1])
    if (!data) continue
    if (m.index > last) {
      out.push({ type: 'text', text: text.slice(last, m.index), styles: node.styles })
    }
    out.push(createDateMentionContent(data) as unknown as InlineNode)
    last = m.index + m[0].length
  }
  if (last === 0) return [node]
  if (last < text.length) {
    out.push({ type: 'text', text: text.slice(last), styles: node.styles })
  }
  return out
}

function normalizeInlineContent(content: Array<any>): { content: Array<any>; didChange: boolean } {
  let didChange = false
  const next: Array<any> = []

  for (const item of content) {
    if (item?.type === 'text') {
      const parts = splitTextNode(item)
      if (parts.length !== 1 || parts[0] !== item) {
        didChange = true
        next.push(...parts)
      } else {
        next.push(item)
      }
      continue
    }
    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

export function normalizeDateMentions(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  if (!JSON.stringify(blocks).includes('((date:')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type === 'codeBlock') return block

    let blockChanged = false
    let nextBlock: Block = block

    if (Array.isArray(block.content)) {
      const normalized = normalizeInlineContent(block.content as any)
      if (normalized.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, content: normalized.content as any }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeDateMentions(block.children as Block[])
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
