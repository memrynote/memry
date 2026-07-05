/* eslint-disable @typescript-eslint/no-explicit-any */

import { type Block } from '@blocknote/core'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  separateBlockImages,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  type BlockColors,
  BLOCK_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import {
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import { splitMarkdownByCallouts, serializeCalloutBlock } from './callout-block'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { serializeYoutubeEmbed } from './youtube-embed-block'
import { serializeBookmark } from './bookmark-block'
import { extractDomain } from '@/lib/url-metadata'
import { serializeTaskBlock } from './task-block/task-block-utils'
import { parseFileBlockMarker, serializeFileBlock, type FileBlockProps } from './file-block-markers'

export function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  if (block.children?.length) return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

const MARKDOWN_LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])

function canSerializeChildNatively(parent: Block, child: Block): boolean {
  return (
    MARKDOWN_LIST_BLOCK_TYPES.has(parent.type as string) &&
    MARKDOWN_LIST_BLOCK_TYPES.has(child.type as string)
  )
}

function hasMarkerSerializedChildren(block: Block): boolean {
  const children = (block.children ?? []) as Block[]
  if (children.length === 0) return false

  return children.some(
    (child) => !canSerializeChildNatively(block, child) || hasMarkerSerializedChildren(child)
  )
}

async function parseMarkdownChunkPreservingNesting(
  editor: any,
  markdown: string
): Promise<Block[]> {
  const chunks = splitMarkdownByBlockNestingMarkers(markdown)
  if (chunks.length === 0) return []

  if (chunks.length === 1 && chunks[0].level === 0) {
    return editor.tryParseMarkdownToBlocks(chunks[0].text)
  }

  const blocks: Block[] = []
  const levels: number[] = []

  for (const chunk of chunks) {
    const parsed = await editor.tryParseMarkdownToBlocks(chunk.text)
    blocks.push(...parsed)
    levels.push(...parsed.map(() => chunk.level))
  }

  return restoreBlockNesting(blocks, levels)
}

async function serializeBlocksWithNestingMarkers(editor: any, blocks: Block[]): Promise<string> {
  const parts: string[] = []
  let currentLevel = 0

  const appendBlock = async (block: Block, level: number): Promise<void> => {
    if (level !== currentLevel) {
      parts.push(createBlockNestingMarker(level))
      currentLevel = level
    }

    const shallowBlock = { ...block, children: [] } as Block
    const markdown = (await editor.blocksToMarkdownLossy([shallowBlock])).trim()
    if (markdown) parts.push(markdown)

    for (const child of (block.children ?? []) as Block[]) {
      await appendBlock(child, level + 1)
    }
  }

  for (const block of blocks) {
    await appendBlock(block, 0)
  }

  if (currentLevel !== 0) {
    parts.push(createBlockNestingMarker(0))
  }

  return parts.join('\n\n')
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
      const blankSegments = splitMarkdownPreservingBlanks(separateBlockImages(cseg.text))
      for (const seg of blankSegments) {
        if (seg.type === 'content') {
          const embedParts = splitByEmbedMarkers(seg.text)
          for (const part of embedParts) {
            if (part.kind === 'embed') {
              blocks.push({
                type: 'youtubeEmbed' as const,
                props: {
                  videoId: part.videoId,
                  videoUrl: part.url,
                  sourceText: part.sourceText ?? ''
                }
              } as unknown as Block)
            } else if (part.kind === 'bookmark') {
              blocks.push({
                type: 'bookmark' as const,
                props: {
                  url: part.url,
                  domain: extractDomain(part.url),
                  title: part.title ?? '',
                  sourceText: part.sourceText ?? ''
                }
              } as unknown as Block)
            } else if (part.kind === 'file') {
              blocks.push({
                type: 'file' as const,
                props: part.props
              } as unknown as Block)
            } else {
              const parsed = await parseMarkdownChunkPreservingNesting(editor, part.text)
              if (part.colors && parsed[0]) {
                parsed[0].props = { ...parsed[0].props, ...part.colors }
              }
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
    // Trim the trailing newline BlockNote appends to list/heading groups; left
    // untrimmed it merges with the segment join into a 3+ newline run that
    // re-parses as a growing blank-line gap on every save (see round-trip tests).
    segments.push({ type: 'content', text: md.trim() })
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
      segments.push({ type: 'content', text: serializeYoutubeEmbed(block.props as any) })
    } else if ((block.type as string) === 'bookmark') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeBookmark(block.props as any) })
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
    } else if (hasNonDefaultColors(block.props as BlockColors)) {
      await flushContent()
      flushGap()
      const blockMd = await editor.blocksToMarkdownLossy([block])
      segments.push({
        type: 'content',
        text: `${serializeBlockColorsMarker(block.props as BlockColors)}\n${blockMd.trim()}`
      })
    } else if (hasMarkerSerializedChildren(block)) {
      await flushContent()
      flushGap()
      segments.push({
        type: 'content',
        text: await serializeBlocksWithNestingMarkers(editor, [block])
      })
    } else {
      flushGap()
      contentGroup.push(block)
    }
  }

  if (contentGroup.length > 0) {
    const md = await editor.blocksToMarkdownLossy(contentGroup)
    segments.push({ type: 'content', text: md.trim() })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}

type EmbedPart =
  | { kind: 'text'; text: string; colors?: BlockColors }
  | { kind: 'embed'; url: string; videoId: string; sourceText?: string }
  | { kind: 'bookmark'; url: string; title?: string; sourceText?: string }
  | { kind: 'file'; props: FileBlockProps }

// Legacy Memry pseudo-image markers, parsed for one release so existing vault
// files migrate: sourceText stays '' and the next save rewrites the marker to
// the canonical plain link. Delete this branch next release (docs/obs/03).
const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/
const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

// Standalone plain-link forms considered for parse-time upgrade (docs/obs/03).
// Anchored: inline links, list items, headings and quotes never match.
const TITLED_LINK_LINE_REGEX = /^\[((?:\\.|[^\\[\]])+)\]\((https?:\/\/[^)\s]+)\)$/
const AUTOLINK_LINE_REGEX = /^<(https?:\/\/[^>\s]+)>$/
const BARE_URL_LINE_REGEX = /^https?:\/\/\S+$/

function unescapeLinkText(text: string): string {
  return text.replace(/\\([[\]])/g, '$1')
}

function matchStandaloneLink(line: string): EmbedPart | null {
  let url: string | null = null
  let title = ''
  const titled = line.match(TITLED_LINK_LINE_REGEX)
  if (titled) {
    title = unescapeLinkText(titled[1])
    url = titled[2]
  } else {
    const autolink = line.match(AUTOLINK_LINE_REGEX)
    if (autolink) url = autolink[1]
    else if (BARE_URL_LINE_REGEX.test(line)) url = line
  }
  if (!url) return null

  const videoId = extractYouTubeVideoId(url)
  if (videoId) return { kind: 'embed', url, videoId, sourceText: line }
  // A titled standalone link is exactly what a bookmark card shows; bare URLs,
  // autolinks and [url](url) stay plain links.
  if (titled && title.trim() && title !== url) {
    return { kind: 'bookmark', url, title, sourceText: line }
  }
  return null
}

// A link upgrades only when it is the sole content line of its blank-line-
// delimited paragraph; color/file marker lines don't count as content.
function findSoleContentLineIndexes(lines: string[]): Set<number> {
  const sole = new Set<number>()
  let paragraph: number[] = []
  const flushParagraph = (): void => {
    const contentLines = paragraph.filter((i) => {
      const trimmed = lines[i].trim()
      return !BLOCK_COLORS_LINE_REGEX.test(trimmed) && !FILE_BLOCK_LINE_REGEX.test(trimmed)
    })
    if (contentLines.length === 1) sole.add(contentLines[0])
    paragraph = []
  }
  lines.forEach((line, i) => {
    if (line.trim() === '') flushParagraph()
    else paragraph.push(i)
  })
  flushParagraph()
  return sole
}

function splitByEmbedMarkers(text: string): EmbedPart[] {
  const lines = text.split('\n')
  const soleContentLines = findSoleContentLineIndexes(lines)
  const parts: EmbedPart[] = []
  let buffer: string[] = []
  let pendingColors: BlockColors | null = null

  const flushBuffer = (): void => {
    if (buffer.length === 0) return
    const part: EmbedPart = { kind: 'text', text: buffer.join('\n') }
    if (pendingColors) part.colors = pendingColors
    parts.push(part)
    buffer = []
    pendingColors = null
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmedLine = line.trim()
    if (BLOCK_COLORS_LINE_REGEX.test(trimmedLine)) {
      const colors = parseBlockColorsMarker(trimmedLine)
      if (colors) {
        flushBuffer()
        pendingColors = colors
        continue
      }
    }
    const fileProps = FILE_BLOCK_LINE_REGEX.test(trimmedLine)
      ? parseFileBlockMarker(trimmedLine)
      : null
    if (fileProps) {
      flushBuffer()
      pendingColors = null
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

    const bookmarkMatch = line.match(BOOKMARK_LINE_REGEX)
    if (bookmarkMatch) {
      flushBuffer()
      parts.push({ kind: 'bookmark', url: bookmarkMatch[1] })
      continue
    }

    if (soleContentLines.has(index)) {
      const standalone = matchStandaloneLink(line)
      if (standalone) {
        flushBuffer()
        parts.push(standalone)
        continue
      }
    }
    buffer.push(line)
  }

  flushBuffer()
  return parts
}
