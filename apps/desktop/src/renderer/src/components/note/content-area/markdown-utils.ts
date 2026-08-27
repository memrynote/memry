/* eslint-disable @typescript-eslint/no-explicit-any */

import { type Block } from '@blocknote/core'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  separateBlockImages,
  extractWikiImageEmbedRefs,
  rewriteWikiImageEmbeds,
  normalizeSerializedMarkdown,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  type BlockColors,
  type TableCellColors,
  applyTableCellColors,
  extractTableCellColors,
  BLOCK_COLORS_LINE_REGEX,
  TABLE_CELL_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  parseTableCellColorsMarker,
  serializeBlockColorsMarker,
  serializeTableCellColorsMarker
} from '@memry/shared/block-colors'
import {
  applyInlineColorTokens,
  extractInlineColorRuns,
  maskInlineColorSpans,
  restoreInlineColorTokens
} from '@memry/shared/inline-colors'
import {
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import { splitMarkdownByCallouts, serializeCalloutBlock } from './callout-block'
import {
  resolveCalloutRun,
  serializeToggleBlock,
  splitMarkdownByToggles,
  type ToggleBlockSegment
} from '@memry/editor-schema/blocks'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import { serializeYoutubeEmbed } from './youtube-embed-block'
import { serializeBookmark } from './bookmark-block'
import { extractDomain } from '@/lib/url-metadata'
import { serializeTaskBlock } from './task-block/task-block-utils'
import { parseFileBlockMarker, serializeFileBlock, type FileBlockProps } from './file-block-markers'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

const log = createLogger('MarkdownUtils')

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

/**
 * The marker lines a block needs in front of it to keep the colors markdown
 * cannot carry: its own text/background color, and — for a table — the colors
 * of its individual cells. Empty for everything else, so a note with no colored
 * block keeps exactly the bytes it had.
 */
function colorMarkerLines(block: Block): string[] {
  const lines: string[] = []
  if (hasNonDefaultColors(block.props as BlockColors)) {
    lines.push(serializeBlockColorsMarker(block.props as BlockColors))
  }
  const cellColors = extractTableCellColors(block.content)
  if (cellColors) lines.push(serializeTableCellColorsMarker(cellColors))
  return lines
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

// Funnel every BlockNote serialization through the shared normalizer so the
// renderer save path matches the main/CRDT path (blocknote-converter.ts): `-`
// bullets, tight lists, and single-newline paragraphs instead of remark's raw
// `*` / loose / `\`-hard-break defaults. Without this the two serializers drift
// and typed notes get rewritten to the loose remark style on disk. Inline
// text/background colors would be dropped by blocksToMarkdownLossy, so colored
// runs are wrapped in tokens first and re-emitted as `<span style="…">` after.
async function serializeBlocks(editor: any, blocks: Block[]): Promise<string> {
  const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks as never[])
  const md = normalizeSerializedMarkdown(await editor.blocksToMarkdownLossy(wrapped))
  return restoreInlineColorTokens(md, replacements)
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
    const markdown = (await serializeBlocks(editor, [shallowBlock])).trim()
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

/**
 * A toggle owns its whole subtree on disk: the children go INSIDE the
 * `<details>`, serialized by the same top-level walk, so nested toggles, images
 * and blank-line gaps inside a toggle behave exactly as they do on a page.
 *
 * The toggle's own line is serialized as a paragraph, not as itself: BlockNote
 * writes a `toggleListItem` as a plain `<li>` (its `toExternalHTML`), which
 * would put a stray `- ` inside the `<summary>`.
 */
async function serializeToggle(editor: any, block: Block): Promise<string> {
  const summaryBlock = { ...block, type: 'paragraph', children: [] } as unknown as Block
  const summary = (await serializeBlocks(editor, [summaryBlock])).trim()
  const children = (block.children ?? []) as Block[]
  const body = children.length > 0 ? await serializeBlocksPreservingBlanks(editor, children) : ''
  const colors = block.props as BlockColors
  const colorsMarker = hasNonDefaultColors(colors) ? serializeBlockColorsMarker(colors) : null

  return serializeToggleBlock(summary, body, colorsMarker)
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

/**
 * Turn Obsidian image embeds into the `![alt](target)` form BlockNote parses
 * into an image block. The main process resolves the target against the vault;
 * anything it cannot find is left as the author wrote it. Failures degrade to
 * "no embeds resolved" rather than blocking the note from opening.
 *
 * `notePath` matters beyond correctness: with it the target comes back relative
 * to the note, so saving the note writes a portable link rather than this
 * machine's absolute path into a file that syncs. Callers that never persist
 * what they render may omit it.
 */
async function resolveWikiImageEmbeds(markdown: string, notePath?: string): Promise<string> {
  const refs = extractWikiImageEmbedRefs(markdown)
  if (refs.length === 0) return markdown

  let resolved: Record<string, string> = {}
  try {
    resolved = (await window.api?.vault?.resolveEmbeds?.({ refs, notePath })) ?? {}
  } catch (error) {
    // Every wiki image embed in the note renders broken past this point.
    log.error('Failed to resolve wiki image embeds', error)
    trackRendererError('editor_resolve_embeds', error)
    return markdown
  }

  return rewriteWikiImageEmbeds(markdown, (ref) => resolved[ref])
}

export async function parseMarkdownPreservingBlanks(
  editor: any,
  markdown: string,
  notePath?: string
): Promise<Block[]> {
  const withEmbeds = await resolveWikiImageEmbeds(markdown, notePath)
  // Inline color spans are masked into markdown-inert tokens before parsing
  // (BlockNote strips raw spans), then re-applied as styles on the parsed runs.
  const { text: maskedMarkdown, spans } = maskInlineColorSpans(withEmbeds)
  const blocks = await parseMaskedMarkdown(editor, maskedMarkdown)

  return applyInlineColorTokens(blocks as never[], spans) as Block[]
}

/**
 * Toggle regions come off FIRST, before the callout / blank-line / marker
 * scanners: those read one line at a time and would shred a toggle body apart
 * at its own paragraph gaps. Each body re-enters this function, so a toggle
 * nested inside a toggle works at any depth, images and all.
 *
 * A toggle nested under a LIST item is out of scope here — it reaches markdown
 * through the block-nesting markers and still flattens to a bullet, exactly as
 * it did before (#1643 is about toggles on a page).
 */
async function parseMaskedMarkdown(editor: any, markdown: string): Promise<Block[]> {
  const blocks: Block[] = []

  for (const segment of splitMarkdownByToggles(markdown)) {
    if (segment.kind === 'toggle') {
      blocks.push(await parseToggleSegment(editor, segment))
    } else {
      blocks.push(...(await parseMarkdownWithoutToggles(editor, segment.text)))
    }
  }

  return blocks
}

async function parseToggleSegment(editor: any, segment: ToggleBlockSegment): Promise<Block> {
  const parsedSummary = await editor.tryParseMarkdownToBlocks(segment.summary)
  const colors = segment.colorsMarker ? parseBlockColorsMarker(segment.colorsMarker) : null

  return {
    type: 'toggleListItem' as const,
    props: { ...(colors ?? {}) },
    content: parsedSummary[0]?.content ?? [],
    children: segment.body ? await parseMaskedMarkdown(editor, segment.body) : []
  } as unknown as Block
}

async function parseMarkdownWithoutToggles(editor: any, markdown: string): Promise<Block[]> {
  const calloutSegments = splitMarkdownByCallouts(markdown)
  const blocks: Block[] = []

  for (const cseg of calloutSegments) {
    if (cseg.kind === 'callout') {
      const claimed = await resolveCalloutRun(
        cseg.run,
        async (md) => editor.tryParseMarkdownToBlocks(md),
        async (block) => serializeBlocks(editor, [block as Block])
      )
      if (claimed) {
        blocks.push({
          type: 'callout' as const,
          props: { type: claimed.type },
          content: claimed.content
        } as unknown as Block)
      } else {
        // A run the byte-round-trip guard declines is not ours to reshape:
        // parse its original lines exactly as any other markdown.
        await parseMarkdownSegmentText(editor, cseg.run.raw, blocks)
      }
    } else {
      await parseMarkdownSegmentText(editor, cseg.text, blocks)
    }
  }

  return blocks
}

async function parseMarkdownSegmentText(editor: any, text: string, blocks: Block[]): Promise<void> {
  const blankSegments = splitMarkdownPreservingBlanks(separateBlockImages(text))
  for (const seg of blankSegments) {
    if (seg.type === 'content') {
      const embedParts = splitByEmbedMarkers(seg.text)
      for (const part of embedParts) {
        if (part.kind === 'embed') {
          blocks.push({
            type: 'youtubeEmbed' as const,
            props: { videoId: part.videoId, videoUrl: part.url }
          } as unknown as Block)
        } else if (part.kind === 'bookmark') {
          blocks.push({
            type: 'bookmark' as const,
            props: { url: part.url, domain: extractDomain(part.url) }
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
          if (part.tableColors && parsed[0]) {
            applyTableCellColors(parsed[0].content, part.tableColors)
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

export async function serializeBlocksPreservingBlanks(
  editor: any,
  blocks: Block[]
): Promise<string> {
  const segments: MarkdownSegment[] = []
  let contentGroup: Block[] = []
  let emptyCount = 0

  const flushContent = async (): Promise<void> => {
    if (contentGroup.length === 0) return
    const md = await serializeBlocks(editor, contentGroup)
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
    const colorMarkers = colorMarkerLines(block)

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
    } else if ((block.type as string) === 'bookmark') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeBookmark((block.props as any).url) })
    } else if ((block.type as string) === 'file') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeFileBlock(block.props as FileBlockProps) })
    } else if ((block.type as string) === 'callout') {
      await flushContent()
      flushGap()
      const calloutType = (block.props as any).type as string
      const contentMd = await serializeBlocks(editor, [block])
      segments.push({
        type: 'content',
        text: serializeCalloutBlock(calloutType, contentMd.trim())
      })
    } else if ((block.type as string) === 'toggleListItem') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: await serializeToggle(editor, block) })
    } else if (isEmptyParagraph(block)) {
      await flushContent()
      emptyCount++
    } else if (colorMarkers.length > 0) {
      await flushContent()
      flushGap()
      const blockMd = await serializeBlocks(editor, [block])
      segments.push({
        type: 'content',
        text: `${colorMarkers.join('\n')}\n${blockMd.trim()}`
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
    const md = await serializeBlocks(editor, contentGroup)
    segments.push({ type: 'content', text: md.trim() })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}

type EmbedPart =
  | { kind: 'text'; text: string; colors?: BlockColors; tableColors?: TableCellColors }
  | { kind: 'embed'; url: string; videoId: string }
  | { kind: 'bookmark'; url: string }
  | { kind: 'file'; props: FileBlockProps }

const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/
const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

function splitByEmbedMarkers(text: string): EmbedPart[] {
  const lines = text.split('\n')
  const parts: EmbedPart[] = []
  let buffer: string[] = []
  let pendingColors: BlockColors | null = null
  let pendingTableColors: TableCellColors | null = null

  const flushBuffer = (): void => {
    if (buffer.length === 0) return
    const part: EmbedPart = { kind: 'text', text: buffer.join('\n') }
    if (pendingColors) part.colors = pendingColors
    if (pendingTableColors) part.tableColors = pendingTableColors
    parts.push(part)
    buffer = []
    pendingColors = null
    pendingTableColors = null
  }

  for (const line of lines) {
    const trimmedLine = line.trim()
    if (BLOCK_COLORS_LINE_REGEX.test(trimmedLine)) {
      const colors = parseBlockColorsMarker(trimmedLine)
      if (colors) {
        flushBuffer()
        pendingColors = colors
        continue
      }
    }
    // Same rule, one level down: the colors of the individual cells of the
    // table that follows. `flushBuffer` returns early on an empty buffer, so
    // the two markers can sit on consecutive lines without clearing each other.
    if (TABLE_CELL_COLORS_LINE_REGEX.test(trimmedLine)) {
      const cellColors = parseTableCellColorsMarker(trimmedLine)
      if (cellColors) {
        flushBuffer()
        pendingTableColors = cellColors
        continue
      }
    }
    const fileProps = FILE_BLOCK_LINE_REGEX.test(trimmedLine)
      ? parseFileBlockMarker(trimmedLine)
      : null
    if (fileProps) {
      flushBuffer()
      pendingColors = null
      pendingTableColors = null
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
    buffer.push(line)
  }

  flushBuffer()
  return parts
}
