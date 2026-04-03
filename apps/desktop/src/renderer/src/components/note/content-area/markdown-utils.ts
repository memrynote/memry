/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

import { type Block } from '@blocknote/core'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  splitMarkdownByCallouts,
  serializeCalloutBlock
} from './callout-block'

export function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

export async function parseMarkdownPreservingBlanks(
  editor: any,
  markdown: string
): Promise<Block[]> {
  const calloutSegments = splitMarkdownByCallouts(markdown)
  const blocks: Block[] = []

  for (const cseg of calloutSegments) {
    if (cseg.kind === 'callout') {
      const parsed = await editor.tryParseMarkdownToBlocks(cseg.content)
      const inlineContent = parsed[0]?.content ?? cseg.content
      blocks.push({
        type: 'callout' as const,
        props: { type: cseg.type },
        content: inlineContent
      } as unknown as Block)
    } else {
      const blankSegments = splitMarkdownPreservingBlanks(cseg.text)
      for (const seg of blankSegments) {
        if (seg.type === 'content') {
          const parsed = await editor.tryParseMarkdownToBlocks(seg.text)
          blocks.push(...parsed)
        } else {
          for (let i = 0; i < seg.extraLines; i++) {
            blocks.push({
              type: 'paragraph',
              content: [],
              children: [],
              id: '',
              props: {}
            } as unknown as Block)
          }
        }
      }
    }
  }

  return blocks
}

export async function serializeBlocksPreservingBlanks(
  editor: any,
  blocks: Block[]
): Promise<string> {
  const segments: MarkdownSegment[] = []
  let contentGroup: Block[] = []
  let emptyCount = 0

  const flushContent = async (): Promise<void> => {
    if (contentGroup.length === 0) return
    const md = await editor.blocksToMarkdownLossy(contentGroup)
    segments.push({ type: 'content', text: md })
    contentGroup = []
  }

  const flushGap = (): void => {
    if (emptyCount === 0) return
    segments.push({ type: 'gap', extraLines: emptyCount })
    emptyCount = 0
  }

  for (const block of blocks) {
    if ((block.type as string) === 'callout') {
      await flushContent()
      flushGap()
      const calloutType = (block.props as any).type as string
      const contentMd = await editor.blocksToMarkdownLossy([block])
      segments.push({
        type: 'content',
        text: serializeCalloutBlock(calloutType, contentMd.trim())
      })
    } else if (isEmptyParagraph(block)) {
      await flushContent()
      emptyCount++
    } else {
      flushGap()
      contentGroup.push(block)
    }
  }

  if (contentGroup.length > 0) {
    const md = await editor.blocksToMarkdownLossy(contentGroup)
    segments.push({ type: 'content', text: md })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
