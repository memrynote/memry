/* oxlint-disable typescript/no-explicit-any */

import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'
import { type Block } from '@blocknote/core'
import {
  assembleMarkdownWithBlanks,
  extractWikiImageEmbedRefs,
  rewriteWikiImageEmbeds,
  normalizeSerializedMarkdown,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import { hasNonDefaultColors, serializeBlockColorsMarker } from '@memry/shared/block-colors'
import { sidecarMarkerLines } from '@memry/shared/block-markers'
import { extractInlineColorRuns, restoreInlineColorTokens } from '@memry/shared/inline-colors'
import { createBlockNestingMarker } from '@memry/shared/block-nesting'
import { withPlainCheckboxMarkers } from '@memry/shared/plain-checkbox'
import { serializeCalloutBlock } from './callout-block'
import { writeHtmlCommentTokens } from '@memry/editor-schema/inline'
import { parseNoteMarkdown } from '@memry/editor-schema/note-markdown'
import { parseMarkdownToBlocksRepaired } from '@memry/editor-schema/parse-markdown'
import { maskHtmlComments } from '@memry/shared/html-comments'
import {
  serializeMathBlock,
  serializeQuoteBlock,
  serializeToggleBlock,
  serializeWhiteboard,
  serializeColumnListBlock
} from '@memry/editor-schema/blocks'
import { markedBlock, propsFor, schemaBlock, schemaBlocks } from './block-casts'
import { serializeYoutubeEmbed } from './youtube-embed-block'
import { serializeBookmark } from './bookmark-block'
import { serializeTaskBlockTree } from './task-block/task-block-utils'
import { serializeFileBlock } from './file-block-markers'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'

const log = createLogger('MarkdownUtils')

const CHECKBOX_MARKER = /^[-*+] \[[ xX]\] ?/

/**
 * The block's line as the file holds it, without the `- [ ] ` marker.
 *
 * A task block keeps its line in one `title` string, written back verbatim
 * before `{task:<id>}`, so whatever this leaves out (a wiki link, a link, bold)
 * is gone from the note on every device it syncs to. Serialized as the
 * checkbox it is, so the bytes are the ones the line already had. This is
 * `serializeBlocks` minus the await: `blocksToMarkdownLossy` is synchronous.
 */
export function checkboxLineMarkdown(editor: any, block: { content?: unknown }): string {
  const line = { type: 'checkListItem', props: { checked: false }, content: block.content }
  const { blocks, replacements } = extractInlineColorRuns([line])
  const md = normalizeSerializedMarkdown(
    writeHtmlCommentTokens(blocks, (b) => editor.blocksToMarkdownLossy(b))
  )
  return restoreInlineColorTokens(md, replacements).trim().replace(CHECKBOX_MARKER, '').trim()
}

export function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  if (block.children?.length) return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

/** Twin of main's `isEmptyWhiteboard`: a board with no canvas writes nothing. */
function isEmptyWhiteboard(block: Block): boolean {
  if ((block.type as string) !== 'whiteboard' || block.children?.length) return false
  const props: object = block.props
  return !('canvasId' in props) || !props.canvasId
}

/** The whiteboard's line, or nothing for a board with no canvas (see server-specs.ts). */
function whiteboardMarkdown(block: Block): string {
  const props: object = block.props
  return 'canvasId' in props && typeof props.canvasId === 'string' && props.canvasId
    ? serializeWhiteboard(props.canvasId)
    : ''
}

const MARKDOWN_LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])

function canSerializeChildNatively(parent: Block, child: Block): boolean {
  return MARKDOWN_LIST_BLOCK_TYPES.has(parent.type) && MARKDOWN_LIST_BLOCK_TYPES.has(child.type)
}

function hasMarkerSerializedChildren(block: Block): boolean {
  const children = (block.children ?? []) as Block[]
  if (children.length === 0) return false

  return children.some(
    (child) => !canSerializeChildNatively(block, child) || hasMarkerSerializedChildren(child)
  )
}

// Funnel every BlockNote serialization through the shared normalizer so the
// renderer save path matches the main/CRDT path (blocknote-converter.ts): `-`
// bullets, tight lists, and single-newline paragraphs instead of remark's raw
// `*` / loose / `\`-hard-break defaults. Without this the two serializers drift
// and typed notes get rewritten to the loose remark style on disk. Inline
// text/background colors would be dropped by blocksToMarkdownLossy, so colored
// runs are wrapped in tokens first and re-emitted as `<span style="…">` after.
async function serializeBlocks(editor: any, blocks: Block[]): Promise<string> {
  const { blocks: wrapped, replacements } = extractInlineColorRuns(withPlainCheckboxMarkers(blocks))
  const md = normalizeSerializedMarkdown(
    // oxlint-disable-next-line typescript/await-thenable -- `editor` is untyped, so TS picks the sync overload; serializers may be async
    await writeHtmlCommentTokens(wrapped, (b) => editor.blocksToMarkdownLossy(b))
  )
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

    // A nested block takes the same per-type dispatch as a top-level one.
    // BlockNote's own exporter would render custom blocks through their React
    // `toExternalHTML`, which drops a task, a callout's marker or a bookmark's
    // target (#2365). A toggle is the exception: nested, it flattens to a
    // bullet exactly as main writes it.
    const shallowBlock = { ...block, children: [] } as Block
    const markdown = (
      (block.type as string) === 'toggleListItem'
        ? await serializeBlocks(editor, [shallowBlock])
        : await serializeBlocksPreservingBlanks(editor, [shallowBlock])
    ).trim()
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
  // `open` comes off with the type: BlockNote compares every prop against the
  // target block's propSchema, and a paragraph has no `open` to compare with —
  // it throws there, which loses the whole document's serialization.
  const { open: isOpen, ...summaryProps } = propsFor(block, 'toggleListItem')
  // SAFETY: `Block` is a union discriminated on the schema's block types with
  // `props` keyed per type, so no hand-written literal is assignable without
  // naming the whole schema. Every literal cast in this file is that same
  // case — the fields are what the named `type` declares, and the round-trip
  // tests against the main-process twin are what actually check them. Here:
  // a paragraph holding the toggle's content, minus the `open` prop a
  // paragraph's propSchema has no slot for.
  const summaryBlock = schemaBlock({
    ...block,
    type: 'paragraph',
    props: summaryProps,
    children: []
  })
  const summary = (await serializeBlocks(editor, [summaryBlock])).trim()
  const children = (block.children ?? []) as Block[]
  const body = children.length > 0 ? await serializeBlocksPreservingBlanks(editor, children) : ''
  const colors = propsFor(block, 'toggleListItem')
  const colorsMarker = hasNonDefaultColors(colors) ? serializeBlockColorsMarker(colors) : null

  return serializeToggleBlock(summary, body, colorsMarker, isOpen === true)
}

function isStructuredQuote(block: Block): boolean {
  return (block.type as string) === 'quote' && ((block.children ?? []) as Block[]).length > 0
}

/**
 * A quote block that owns children writes them INSIDE the blockquote, one `> `
 * per line and a bare `>` per gap — the bytes `readStructuredQuoteRun` reads
 * back. BlockNote's own serializer puts children AFTER the quote (`> A\n\nB`),
 * which is how a blank quote line and a nested callout were lost (#1881).
 * Byte-identical to the main process's `serializeQuote`.
 */
async function serializeQuote(editor: any, block: Block): Promise<string> {
  // SAFETY: the quote's own inline content as a bare paragraph, so it is
  // serialized without the `> ` that `serializeQuoteBlock` adds.
  const own = schemaBlock({ ...block, type: 'paragraph', props: {}, children: [] })
  const children = (block.children ?? []) as Block[]
  const inner = await serializeBlocksPreservingBlanks(editor, [own, ...children])
  return serializeQuoteBlock(inner.trim())
}

export function sanitizeBlockIds(blocks: Block[]): Block[] {
  let didChange = false

  const sanitizeBlock = (block: Block): Block => {
    let nextBlock = block
    const id = (block as { id?: unknown }).id

    if (id !== undefined && (typeof id !== 'string' || id.length === 0)) {
      const { id: _removedId, ...rest } = block
      nextBlock = schemaBlock(rest)
      didChange = true
    }

    if (Array.isArray(block.children) && block.children.length > 0) {
      const nextChildren = block.children.map((child) => sanitizeBlock(child as Block))
      const childrenChanged = nextChildren.some((child, index) => child !== block.children[index])
      if (childrenChanged) {
        nextBlock = { ...nextBlock, children: nextChildren }
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
  // HTML comments come off first, as one token each, so no line splitter below
  // reads the inside of a multi-line comment (AF-015).
  const withEmbeds = await resolveWikiImageEmbeds(maskHtmlComments(markdown), notePath)
  // The pipeline is main's too (`markdownToBlocks` in blocknote-converter.ts):
  // the same bytes have to open as the same document in either process.
  const blocks = await parseNoteMarkdown<Block>(
    {
      parse: (md) => parseMarkdownToBlocksRepaired<Block>(editor, md),
      serialize: (parsed) => serializeBlocks(editor, parsed)
    },
    withEmbeds
  )
  return schemaBlocks(blocks)
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
    // Skipped before anything is flushed, exactly where main skips it, so the
    // blank lines around it are accounted the same way on both sides.
    if (isEmptyWhiteboard(block)) continue

    // SAFETY: as in `applyMarkers` — the `{ type, props }` subset.
    const markers = sidecarMarkerLines(markedBlock(block))

    if ((block.type as string) === 'taskBlock') {
      await flushContent()
      flushGap()
      for (const line of serializeTaskBlockTree(block))
        segments.push({ type: 'content', text: line })
    } else if ((block.type as string) === 'youtubeEmbed') {
      await flushContent()
      flushGap()
      const { videoUrl, alt } = propsFor(block, 'youtubeEmbed')
      segments.push({ type: 'content', text: serializeYoutubeEmbed(videoUrl, alt) })
    } else if ((block.type as string) === 'bookmark') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeBookmark(propsFor(block, 'bookmark').url) })
    } else if ((block.type as string) === 'whiteboard' && !block.children?.length) {
      // With children it falls through to the nesting-marker path below, which
      // is where main's content-group serialization sends it too.
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: whiteboardMarkdown(block) })
    } else if ((block.type as string) === 'file') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: serializeFileBlock(propsFor(block, 'file')) })
    } else if ((block.type as string) === 'callout') {
      await flushContent()
      flushGap()
      const { type: calloutType, fold: calloutFold } = propsFor(block, 'callout')
      // Serialized as a PARAGRAPH holding the callout's inline content, the
      // same way `serializeQuote` above does it, rather than as the callout
      // block itself. This block's React render puts its content in a plain
      // `<div>`, and from BlockNote 0.51 a line break inside a container the
      // HTML→markdown step does not recognise as a block is dropped instead of
      // becoming a `<br>`: a two-line callout came back as `> OneTwo`.
      // SAFETY: a paragraph carrying this block's own inline content; `props`
      // is cleared because a paragraph's propSchema has no `type` key.
      // Children are written inside the blockquote after the own line, the
      // shape `resolveCalloutRun` reads back (#3186).
      const own = schemaBlock({ ...block, type: 'paragraph', props: {}, children: [] })
      const children = (block.children ?? []) as Block[]
      const contentMd =
        children.length > 0
          ? await serializeBlocksPreservingBlanks(editor, [own, ...children])
          : await serializeBlocks(editor, [own])
      const calloutMd = serializeCalloutBlock(calloutType, contentMd.trim(), calloutFold)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${calloutMd}` : calloutMd
      })
    } else if ((block.type as string) === 'mathBlock') {
      await flushContent()
      flushGap()
      const latex = propsFor(block, 'mathBlock').latex ?? ''
      const mathMd = serializeMathBlock(latex)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${mathMd}` : mathMd
      })
    } else if ((block.type as string) === 'toggleListItem') {
      await flushContent()
      flushGap()
      segments.push({ type: 'content', text: await serializeToggle(editor, block) })
    } else if ((block.type as string) === 'columnList') {
      await flushContent()
      flushGap()
      segments.push({
        type: 'content',
        text: await serializeColumnListBlock<Block>(block, (children) =>
          serializeBlocksPreservingBlanks(editor, children)
        )
      })
    } else if (isStructuredQuote(block)) {
      await flushContent()
      flushGap()
      const quoted = await serializeQuote(editor, block)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${quoted}` : quoted
      })
    } else if (isEmptyParagraph(block)) {
      await flushContent()
      emptyCount++
    } else if (markers.length > 0) {
      await flushContent()
      flushGap()
      const blockMd = await serializeBlocks(editor, [block])
      segments.push({
        type: 'content',
        text: `${markers.join('\n')}\n${blockMd.trim()}`
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
  // The host editor keeps an empty paragraph after a trailing portal so the
  // caret has somewhere to go (portal-trailing-paragraph-plugin). It is not
  // content: a file ending in the fence stays byte-identical on every save.
  const lastBlock = blocks.findLast((block) => !isEmptyParagraph(block))
  const endsInPortal =
    lastBlock !== undefined &&
    (lastBlock.type as string) === 'codeBlock' &&
    propsFor(lastBlock, 'codeBlock').language === PORTAL_BLOCK_LANGUAGE
  if (emptyCount > 0 && !endsInPortal) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
