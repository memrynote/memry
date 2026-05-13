/* eslint-disable @typescript-eslint/no-explicit-any */

import { type Block } from '@blocknote/core'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import { splitMarkdownByCallouts, serializeCalloutBlock } from './callout-block'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { serializeYoutubeEmbed } from './youtube-embed-block'
import { serializeTaskBlock } from './task-block/task-block-utils'
import { parseFileBlockMarker, serializeFileBlock, type FileBlockProps } from './file-block-markers'

export function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

export function sanitizeBlockIds(blocks: Block[]): Block[] {
  let didChange = false

  const sanitizeBlock = (block: Block): Block => {
    let nextBlock = block
    const id = (block as { id?: unknown }).id

    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      const { id: _removedId, ...rest } = block as Block & { id: unknown }
      nextBlock = rest as Block
      didChange = true
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      const nextChildren = block.children.map((child) => sanitizeBlock(child as Block))
      const childrenChanged = nextChildren.some((child, index) => child !== block.children[index])
      if (childrenChanged) {
        nextBlock = { ...nextBlock, children: nextChildren } as Block
        didChange = true
      }
    }

    return nextBlock
  }

  const nextBlocks = blocks.map(sanitizeBlock)
  return didChange ? nextBlocks : blocks
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
          const embedParts = splitByEmbedMarkers(seg.text)
          for (const part of embedParts) {
            if (part.kind === 'embed') {
              blocks.push({
                type: 'youtubeEmbed' as const,
                props: { videoId: part.videoId, videoUrl: part.url }
              } as unknown as Block)
            } else if (part.kind === 'file') {
              blocks.push({
                type: 'file' as const,
                props: part.props
              } as unknown as Block)
            } else {
              const parsed = await editor.tryParseMarkdownToBlocks(part.text)
              blocks.push(...parsed)
            }
          }
        } else {
          for (let i = 0; i < seg.extraLines; i++) {
            blocks.push({
              type: 'paragraph',
              content: [],
              children: [],
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
    if ((block.type as string) === 'taskBlock') {
      await flushContent()
      flushGap()
      const props = block.props as {
        taskId: string
        title: string
        checked: boolean
        parentTaskId?: string
      }
      segments.push({ type: 'content', text: serializeTaskBlock(props) })
      if (block.children?.length) {
        for (const child of block.children as Block[]) {
          if ((child.type as string) === 'taskBlock') {
            const childProps = child.props as {
              taskId: string
              title: string
              checked: boolean
              parentTaskId?: string
            }
            segments.push({ type: 'content', text: serializeTaskBlock(childProps) })
          }
        }
      }
    } else if ((block.type as string) === 'youtubeEmbed') {
      await flushContent()
      flushGap()
      const videoUrl = (block.props as any).videoUrl as string
      segments.push({ type: 'content', text: serializeYoutubeEmbed(videoUrl) })
    } else if ((block.type as string) === 'file') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeFileBlock(block.props as FileBlockProps) })
    } else if ((block.type as string) === 'callout') {
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

type EmbedPart =
  | { kind: 'text'; text: string }
  | { kind: 'embed'; url: string; videoId: string }
  | { kind: 'file'; props: FileBlockProps }

const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

function splitByEmbedMarkers(text: string): EmbedPart[] {
  const lines = text.split('\n')
  const parts: EmbedPart[] = []
  let buffer: string[] = []

  const flushBuffer = (): void => {
    if (buffer.length === 0) return
    parts.push({ kind: 'text', text: buffer.join('\n') })
    buffer = []
  }

  for (const line of lines) {
    const trimmedLine = line.trim()
    const fileProps = FILE_BLOCK_LINE_REGEX.test(trimmedLine)
      ? parseFileBlockMarker(trimmedLine)
      : null
    if (fileProps) {
      flushBuffer()
      parts.push({ kind: 'file', props: fileProps })
      continue
    }

    const match = line.match(EMBED_LINE_REGEX)
    if (match) {
      const url = match[1]
      const videoId = extractYouTubeVideoId(url)
      if (videoId) {
        flushBuffer()
        parts.push({ kind: 'embed', url, videoId })
        continue
      }
    }
    buffer.push(line)
  }

  flushBuffer()
  return parts
}
