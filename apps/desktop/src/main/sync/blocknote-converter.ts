import { ServerBlockNoteEditor } from '@blocknote/server-util'
import {
  type Block,
  type PartialBlock,
  BlockNoteSchema,
  defaultBlockSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { parseCriticMarkup, writeCriticMarkupMarksToYDoc } from '@memry/shared'
import {
  type BlockColors,
  BLOCK_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import {
  splitMarkdownPreservingBlanks,
  assembleMarkdownWithBlanks,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import { createLogger } from '../lib/logger'

const log = createLogger('BlockNoteConverter')

const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions)
  }
})

let serverEditor: ServerBlockNoteEditor | null = null

function getEditor(): ServerBlockNoteEditor {
  if (!serverEditor) {
    serverEditor = ServerBlockNoteEditor.create({ schema: serverSchema })
  }
  return serverEditor
}

export async function yDocToMarkdown(
  doc: Y.Doc,
  fragmentName = CRDT_FRAGMENT_NAME
): Promise<string | null> {
  try {
    const editor = getEditor()
    const fragment = doc.getXmlFragment(fragmentName)
    const blocks = editor.yXmlFragmentToBlocks(fragment)
    if (blocks.length === 0) return ''
    return await blocksToMarkdownPreserving(editor, blocks as Block[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}

export async function markdownToBlocks(markdown: string): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return await markdownToBlocksPreserving(editor, markdown)
  } catch (err) {
    log.error('Markdown-to-blocks conversion failed', err)
    return null
  }
}

export function blocksToYFragment(blocks: Block[], fragment: Y.XmlFragment): boolean {
  try {
    const editor = getEditor()
    editor.blocksToYXmlFragment(blocks, fragment)
    return true
  } catch (err) {
    log.error('Blocks-to-Yjs conversion failed', err)
    return false
  }
}

export async function markdownToYFragment(
  markdown: string,
  fragment: Y.XmlFragment
): Promise<boolean> {
  const parsed = parseCriticMarkup(markdown)
  const blocks = await markdownToBlocks(parsed.plainText)
  if (!blocks) return false
  const ok = blocksToYFragment(blocks, fragment)
  if (ok && fragment.doc) {
    writeCriticMarkupMarksToYDoc(fragment.doc, parsed.marks)
  }
  return ok
}

export async function yFragmentToBlocks(fragment: Y.XmlFragment): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return editor.yXmlFragmentToBlocks(fragment)
  } catch (err) {
    log.error('Yjs-to-blocks conversion failed', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Empty-line-preserving conversion helpers
// ---------------------------------------------------------------------------

function isEmptyParagraph(block: Block): boolean {
  if (block.type !== 'paragraph') return false
  if (block.children?.length) return false
  const content = block.content as unknown[]
  return !content || content.length === 0
}

function createEmptyParagraph(): Block {
  return {
    type: 'paragraph',
    content: [],
    children: [],
    id: '',
    props: {}
  } as unknown as Block
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
  editor: ServerBlockNoteEditor,
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
    blocks.push(...(parsed as Block[]))
    levels.push(...parsed.map(() => chunk.level))
  }

  return restoreBlockNesting(blocks, levels)
}

async function serializeBlocksWithNestingMarkers(
  editor: ServerBlockNoteEditor,
  blocks: Block[]
): Promise<string> {
  const parts: string[] = []
  let currentLevel = 0

  const appendBlock = async (block: Block, level: number): Promise<void> => {
    if (level !== currentLevel) {
      parts.push(createBlockNestingMarker(level))
      currentLevel = level
    }

    const shallowBlock = { ...block, children: [] } as Block
    const markdown = (await editor.blocksToMarkdownLossy([shallowBlock] as PartialBlock[])).trim()
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

async function markdownToBlocksPreserving(
  editor: ServerBlockNoteEditor,
  markdown: string
): Promise<Block[]> {
  const segments = splitMarkdownPreservingBlanks(markdown)
  const blocks: Block[] = []

  for (const seg of segments) {
    if (seg.type === 'content') {
      blocks.push(...(await parseContentWithColorMarkers(editor, seg.text)))
    } else {
      for (let i = 0; i < seg.extraLines; i++) {
        blocks.push(createEmptyParagraph())
      }
    }
  }

  return blocks
}

async function parseContentWithColorMarkers(
  editor: ServerBlockNoteEditor,
  text: string
): Promise<Block[]> {
  const blocks: Block[] = []
  let buffer: string[] = []
  let pendingColors: BlockColors | null = null

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return
    const parsed = await parseMarkdownChunkPreservingNesting(editor, buffer.join('\n'))
    if (pendingColors && parsed[0]) {
      parsed[0].props = { ...parsed[0].props, ...pendingColors }
    }
    pendingColors = null
    blocks.push(...(parsed as Block[]))
    buffer = []
  }

  for (const line of text.split('\n')) {
    if (BLOCK_COLORS_LINE_REGEX.test(line.trim())) {
      const colors = parseBlockColorsMarker(line.trim())
      if (colors) {
        await flushBuffer()
        pendingColors = colors
        continue
      }
    }
    buffer.push(line)
  }
  await flushBuffer()

  return blocks
}

async function blocksToMarkdownPreserving(
  editor: ServerBlockNoteEditor,
  blocks: Block[]
): Promise<string> {
  const segments: MarkdownSegment[] = []
  let contentGroup: Block[] = []
  let emptyCount = 0

  for (const block of blocks) {
    if (isEmptyParagraph(block)) {
      if (contentGroup.length > 0) {
        const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md })
        contentGroup = []
      }
      emptyCount++
    } else if (hasNonDefaultColors(block.props as BlockColors)) {
      if (contentGroup.length > 0) {
        const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md })
        contentGroup = []
      }
      if (emptyCount > 0) {
        segments.push({ type: 'gap', extraLines: emptyCount })
        emptyCount = 0
      }
      const blockMd = await editor.blocksToMarkdownLossy([block] as PartialBlock[])
      segments.push({
        type: 'content',
        text: `${serializeBlockColorsMarker(block.props as BlockColors)}\n${blockMd.trim()}`
      })
    } else if (hasMarkerSerializedChildren(block)) {
      if (contentGroup.length > 0) {
        const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md })
        contentGroup = []
      }
      if (emptyCount > 0) {
        segments.push({ type: 'gap', extraLines: emptyCount })
        emptyCount = 0
      }
      segments.push({
        type: 'content',
        text: await serializeBlocksWithNestingMarkers(editor, [block])
      })
    } else {
      if (emptyCount > 0) {
        segments.push({ type: 'gap', extraLines: emptyCount })
        emptyCount = 0
      }
      contentGroup.push(block)
    }
  }

  if (contentGroup.length > 0) {
    const md = await editor.blocksToMarkdownLossy(contentGroup as PartialBlock[])
    segments.push({ type: 'content', text: md })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
