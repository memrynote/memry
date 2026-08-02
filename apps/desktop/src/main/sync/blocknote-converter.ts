import { ServerBlockNoteEditor } from '@blocknote/server-util'
import {
  type Block,
  type PartialBlock,
  BlockNoteSchema,
  defaultBlockSpecs,
  createBlockSpec,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { randomUUID } from 'node:crypto'
import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { parseCriticMarkup, writeCriticMarkupMarksToYDoc } from '@memry/shared'
import {
  normalizeTaskBlocks,
  serializeTaskBlock,
  type TaskBlockProps
} from '@memry/shared/task-block'
import {
  type BlockColors,
  BLOCK_COLORS_LINE_REGEX,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import {
  applyInlineColorTokens,
  extractInlineColorRuns,
  maskInlineColorSpans,
  restoreInlineColorTokens
} from '@memry/shared/inline-colors'
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
  createBlockNestingMarker,
  restoreBlockNesting,
  splitMarkdownByBlockNestingMarkers
} from '@memry/shared/block-nesting'
import { createLogger } from '../lib/logger'
import { resolveVaultEmbeds } from '../vault/resolve-embed'

const log = createLogger('BlockNoteConverter')

// Headless `taskBlock` node so the CRDT fragment stores the SAME custom block
// the renderer paints. Seeding a raw `checkListItem` would flash a plain
// checkbox on open and — via the renderer's checkbox→task converter — mint a
// duplicate task. Only the node schema (type + props + content) is used for
// (de)serialization here; the server never renders, so `render` throws if it is
// ever reached. propSchema must stay identical to the renderer's taskBlock
// (task-block/index.tsx) or yXmlFragmentToBlocks would mis-parse the props.
const createServerTaskBlock = createBlockSpec(
  {
    type: 'taskBlock' as const,
    propSchema: {
      taskId: { default: '' },
      title: { default: '' },
      checked: { default: false },
      parentTaskId: { default: '' }
    },
    content: 'none'
  },
  {
    render: () => {
      throw new Error('taskBlock server spec is serialization-only and must not be rendered')
    }
  }
)

const serverSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    taskBlock: createServerTaskBlock()
  }
})

let serverEditor: ServerBlockNoteEditor | null = null

function getEditor(): ServerBlockNoteEditor {
  if (!serverEditor) {
    // The custom taskBlock adds a key absent from the default block schema, so
    // the create() return type no longer matches the default-parameterised
    // `ServerBlockNoteEditor`. The extra block only matters at runtime (for
    // (de)serialization); erase it from the type so the existing default-typed
    // helpers keep working.
    serverEditor = ServerBlockNoteEditor.create({ schema: serverSchema }) as ServerBlockNoteEditor
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

export async function markdownToBlocks(
  markdown: string,
  notePath?: string
): Promise<Block[] | null> {
  try {
    const editor = getEditor()
    return await markdownToBlocksPreserving(editor, markdown, notePath)
  } catch (err) {
    log.error('Markdown-to-blocks conversion failed', err)
    return null
  }
}

// BlockNote's headless serializer regenerates a MISSING block id but writes an
// explicit empty-string id as-is. An empty id then trips the renderer's block
// resolver ("Block doesn't have id") and crashes the editor. Stamp a real id on
// any block whose id is falsy before serializing.
function ensureBlockIds(blocks: Block[]): void {
  for (const block of blocks) {
    if (!block.id) (block as { id: string }).id = randomUUID()
    const children = block.children as Block[] | undefined
    if (children?.length) ensureBlockIds(children)
  }
}

export function blocksToYFragment(blocks: Block[], fragment: Y.XmlFragment): boolean {
  try {
    const editor = getEditor()
    ensureBlockIds(blocks)
    editor.blocksToYXmlFragment(blocks, fragment)
    return true
  } catch (err) {
    log.error('Blocks-to-Yjs conversion failed', err)
    return false
  }
}

const BLOCK_CONTAINER_NODES = new Set(['blockContainer', 'columnList', 'column'])

// Repair notes already persisted with empty-string block ids: walk the CRDT
// fragment and stamp a fresh id on any block container missing one. Runs on
// note open so previously-corrupted notes heal instead of showing "Editor
// Error". Returns the number of blocks repaired.
export function repairEmptyBlockIds(fragment: Y.XmlFragment): number {
  let repaired = 0
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      const el = child as Y.XmlElement
      if (typeof el.nodeName !== 'string' || typeof el.getAttribute !== 'function') continue
      if (BLOCK_CONTAINER_NODES.has(el.nodeName) && !el.getAttribute('id')) {
        el.setAttribute('id', randomUUID())
        repaired++
      }
      visit(el)
    }
  }
  visit(fragment)
  return repaired
}

export async function markdownToYFragment(
  markdown: string,
  fragment: Y.XmlFragment,
  notePath?: string
): Promise<boolean> {
  const parsed = parseCriticMarkup(markdown)
  const blocks = await markdownToBlocks(parsed.plainText, notePath)
  if (!blocks) return false
  // Upgrade `- [ ] … {task:id}` checkboxes into taskBlock nodes so the renderer
  // binds the custom block on first paint instead of a raw checkbox.
  const normalized = normalizeTaskBlocks(blocks).blocks
  const ok = blocksToYFragment(normalized, fragment)
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
    id: randomUUID(),
    props: {}
  } as unknown as Block
}

const MARKDOWN_LIST_BLOCK_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem'])

// Every blocks→markdown serialization funnels through here so list markers,
// list tightness, and soft breaks stay byte-friendly against vault files.
// See normalizeSerializedMarkdown. Inline text/background colors would be
// dropped by blocksToMarkdownLossy, so colored runs are wrapped in tokens
// first and re-emitted as `<span style="…">` after serialization.
async function serializeBlocks(
  editor: ServerBlockNoteEditor,
  blocks: PartialBlock[]
): Promise<string> {
  const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks as never[])
  const md = normalizeSerializedMarkdown(
    await editor.blocksToMarkdownLossy(wrapped as PartialBlock[])
  )
  return restoreInlineColorTokens(md, replacements)
}

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
    const markdown = (await serializeBlocks(editor, [shallowBlock] as PartialBlock[])).trim()
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
 * Main-process twin of the renderer's embed resolution: same rewrite, but the
 * vault lookup is a direct call instead of an IPC round trip. A closed vault or
 * an unreadable index resolves nothing, which leaves every embed as written.
 */
function resolveWikiImageEmbedsInMarkdown(markdown: string, notePath?: string): string {
  const refs = extractWikiImageEmbedRefs(markdown)
  if (refs.length === 0) return markdown

  try {
    const resolved = resolveVaultEmbeds(refs, notePath)
    return rewriteWikiImageEmbeds(markdown, (ref) => resolved[ref])
  } catch {
    return markdown
  }
}

async function markdownToBlocksPreserving(
  editor: ServerBlockNoteEditor,
  markdown: string,
  notePath?: string
): Promise<Block[]> {
  // Obsidian image embeds become `![alt](memry-file://…)` first, so the same
  // note renders identically here and in the editor (see normalize-note-blocks).
  const withEmbeds = resolveWikiImageEmbedsInMarkdown(markdown, notePath)
  // Inline color spans are masked into markdown-inert tokens before parsing
  // (BlockNote strips raw spans), then re-applied as styles on the parsed runs.
  const { text, spans } = maskInlineColorSpans(separateBlockImages(withEmbeds))
  const segments = splitMarkdownPreservingBlanks(text)
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

  return applyInlineColorTokens(blocks as never[], spans) as Block[]
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
    blocks.push(...parsed)
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

  const flushContentGroup = async (): Promise<void> => {
    if (contentGroup.length === 0) return
    const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
    // Trim BlockNote's trailing newline (see #524) so content flushed before a
    // taskBlock can't re-parse as a growing blank-line gap on every writeback.
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
      // BlockNote can't serialize a taskBlock (it's content:'none'), so emit the
      // `- [ ] … {task:id}` line ourselves. Subtasks are kept on the immediately
      // following line (tight list) so a re-parse re-nests them under the parent.
      await flushContentGroup()
      flushGap()
      const lines = [serializeTaskBlock(block.props as unknown as TaskBlockProps)]
      for (const child of (block.children ?? []) as Block[]) {
        if ((child.type as string) === 'taskBlock') {
          lines.push(serializeTaskBlock(child.props as unknown as TaskBlockProps))
        }
      }
      segments.push({ type: 'content', text: lines.join('\n') })
    } else if (isEmptyParagraph(block)) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md.trim() })
        contentGroup = []
      }
      emptyCount++
    } else if (hasNonDefaultColors(block.props as BlockColors)) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md.trim() })
        contentGroup = []
      }
      if (emptyCount > 0) {
        segments.push({ type: 'gap', extraLines: emptyCount })
        emptyCount = 0
      }
      const blockMd = await serializeBlocks(editor, [block] as PartialBlock[])
      segments.push({
        type: 'content',
        text: `${serializeBlockColorsMarker(block.props as BlockColors)}\n${blockMd.trim()}`
      })
    } else if (hasMarkerSerializedChildren(block)) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md.trim() })
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
    const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
    // Trim the trailing newline BlockNote appends to list/heading groups; left
    // untrimmed it re-parses as a growing blank-line gap on every writeback.
    segments.push({ type: 'content', text: md.trim() })
  }
  if (emptyCount > 0) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
