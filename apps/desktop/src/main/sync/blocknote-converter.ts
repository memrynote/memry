import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { type Block, type PartialBlock } from '@blocknote/core'
import { createMemrySchema } from '@memry/editor-schema'
import {
  BOOKMARK_LINE_REGEX,
  EMBED_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  parseFileBlockMarker
} from '@memry/editor-schema/blocks'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import { extractYouTubeVideoId } from '@memry/shared/youtube'
import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
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

// The same factory the renderer builds its schema from, so this process cannot
// lack a node type the renderer can author. That symmetry is the whole fix:
// y-prosemirror answers an unknown node name by DELETING the element from the
// shared Y.Doc, so a spec registered on one side only replicates as data loss.
// Main supplies serialization-only implementations — nothing here ever renders.
const serverSchema = createMemrySchema({
  blocks: createServerBlockSpecs(),
  inline: createServerInlineSpecs()
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
    // y-prosemirror's `createNodeFromYElement` DELETES any element it cannot
    // build (dist/y-prosemirror.cjs:878-885) — a repair heuristic that, run on
    // the live doc, turns a serialization gap into replicated data loss. Read
    // from a detached copy so this path can only ever read.
    const snapshot = new Y.Doc()
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc))
    const editor = getEditor()
    const blocks = editor.yXmlFragmentToBlocks(snapshot.getXmlFragment(fragmentName))
    if (blocks.length === 0) {
      // `''` is a real body — the body of a note that has never been written —
      // so an empty result cannot simply be refused. It is only that body when
      // the fragment is empty too: every block a note holds is a
      // `blockContainer`, so a fragment that holds one and converts to no
      // blocks means the repair pass deleted the whole document on the way out
      // (an emptied `tableRow` fails `createChecked`, and
      // `findUnrepresentableNodes` stays silent because it only asks whether
      // the NAME is registered). Writing that empties the user's file and
      // replicates it, so report it the way a failed conversion is reported.
      // Read the ORIGINAL doc here, not the snapshot: the repair already ran
      // over the snapshot and took the evidence with it.
      if (holdsBlockContainer(doc.getXmlFragment(fragmentName))) {
        log.error('Fragment holds blocks but converted to none, refusing to serialize')
        return null
      }
      return ''
    }
    return await blocksToMarkdownPreserving(editor, blocks as Block[])
  } catch (err) {
    log.error('Yjs-to-markdown conversion failed', err)
    return null
  }
}

/** True when the fragment holds at least one block, at any depth. Reads only. */
function holdsBlockContainer(node: Y.XmlFragment | Y.XmlElement): boolean {
  for (const child of node.toArray()) {
    const el = child as Y.XmlElement
    if (typeof el.nodeName !== 'string') continue
    if (el.nodeName === 'blockContainer') return true
    if (holdsBlockContainer(el)) return true
  }
  return false
}

/**
 * Node names in the CRDT fragment that this build's schema cannot CONSTRUCT.
 *
 * Constructibility is the question y-prosemirror's repair heuristic asks first:
 * it answers a node name its schema cannot build by DELETING the element
 * (`createNodeFromYElement`, dist/y-prosemirror.cjs:878-885), so a doc holding
 * one can only ever serialize to markdown that is missing it. Callers use this
 * to refuse the write rather than persist the loss.
 *
 * It does NOT answer "will this node survive serialization", and reading it as
 * though it does is what #1455 is about. A node this build can construct can
 * still be dropped on the way to markdown, in more than one way.
 *
 * It is also narrower than y-prosemirror's own test: this asks whether the NAME
 * is registered, while `schema.node(name, attrs, children)` additionally throws
 * on invalid content and on a required attribute with no default. Measured: a
 * childless `tableRow` is a registered name, so nothing is reported here, and
 * the whole document converts to no blocks. That case is caught downstream
 * instead — `yDocToMarkdown` refuses an empty conversion of a non-empty
 * fragment rather than returning the `''` that would empty the file (#1475).
 *
 * One case worth naming, because it is the one this guard reads as safe: a spec
 * registered under a key that is not its `config.type`. ProseMirror builds the node (its name comes from
 * `config.type`, so nothing is reported here and the write is allowed) while
 * BlockNote's own schema — keyed by the registration key — cannot resolve it
 * and drops it. Measured: `See [[Wiki Link]] for details.` → `See for
 * details.`, guard silent. That invariant is not gated here; it is asserted at
 * construction, in `@memry/editor-schema`'s `assertSpecKeysMatchNodeTypes`, so
 * a mis-keyed spec fails the schema build instead of reaching this function.
 *
 * The oracle is the ProseMirror schema itself, not a hand-written list: node
 * names are not block type names, and a list would miss the ones that never
 * appear in `blockSchema` (a table expands into `tableRow` / `tableCell` /
 * `tableHeader` / `tableParagraph`) — flagging those would strand every note
 * with a table. Reads only; never mutates `doc`.
 */
export function findUnrepresentableNodes(doc: Y.Doc, fragmentName = CRDT_FRAGMENT_NAME): string[] {
  try {
    const known = getEditor().editor.pmSchema.nodes
    const unknown = new Set<string>()
    const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
      for (const child of node.toArray()) {
        const el = child as Y.XmlElement
        // Y.XmlText carries no nodeName — its runs are marks, and the schema
        // holds every mark both processes use.
        if (typeof el.nodeName !== 'string') continue
        if (!(el.nodeName in known)) unknown.add(el.nodeName)
        visit(el)
      }
    }
    visit(doc.getXmlFragment(fragmentName))
    return [...unknown]
  } catch (err) {
    // A schema this broken also fails `yDocToMarkdown`, whose null return keeps
    // the file anyway. Reporting "nothing unknown" here can't cause a write.
    log.error('Unrepresentable-node scan failed', err)
    return []
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
  } catch (err) {
    log.warn('Embed resolution failed, leaving embeds as written', { notePath, error: err })
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

  const fence = createFenceTracker()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    // A marker inside a code fence is the author's text, not a marker.
    const insideFence = fence.consume(line)

    // Deliberately NOT fence-guarded: this branch predates custom-block parsing
    // and guarding it would drop a colour marker that follows a fence this
    // tracker read differently, which is data loss on a path #1432 never
    // touched. The renderer's twin (markdown-utils.ts) is unguarded too.
    if (BLOCK_COLORS_LINE_REGEX.test(trimmed)) {
      const colors = parseBlockColorsMarker(trimmed)
      if (colors) {
        await flushBuffer()
        pendingColors = colors
        continue
      }
    }

    const marker = insideFence ? null : parseCustomBlockMarkerLine(line)
    if (marker) {
      await flushBuffer()
      pendingColors = null
      blocks.push(marker)
      continue
    }

    buffer.push(line)
  }
  await flushBuffer()

  return blocks
}

/**
 * CommonMark fence tracking, not a parity toggle.
 *
 * A boolean flipped by /^(?:```|~~~)/ is wrong in the way that matters here: it
 * tracks neither the fence character nor its length, so a ```` ```` ```` block
 * quoting an inner ``` — the shape of any note that documents this very marker
 * format — reads as closed halfway through. The example marker inside it then
 * parses as a real block and write-back rewrites the file around it.
 *
 * A fence opens with 3+ of ` or ~ (up to 3 leading spaces) and closes only on
 * the SAME character, at least as long, with nothing after it.
 */
function createFenceTracker(): { consume: (line: string) => boolean } {
  let open: { char: string; length: number } | null = null

  return {
    /** True when `line` is inside a fence — the opening/closing lines included. */
    consume: (line) => {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) return open !== null

      const char = match[1][0]
      const length = match[1].length
      if (open === null) {
        // An info string may not contain a backtick (CommonMark 4.5).
        if (char === '`' && match[2].includes('`')) return false
        open = { char, length }
        return true
      }
      if (char === open.char && length >= open.length && match[2].trim() === '') {
        open = null
      }
      return true
    }
  }
}

/**
 * The three custom blocks whose on-disk form is a single marker line.
 *
 * Without this, the main process — which is what seeds a note's shared Y.Doc
 * from the vault file — parses each marker as something else and the block is
 * gone before the editor ever sees it: `<!-- file:{…} -->` is dropped outright
 * (an HTML comment BlockNote has no block for), and both `![…](url)` markers
 * become plain image blocks pointing at a page rather than an image.
 *
 * The renderer's own parser does exactly this (`splitByEmbedMarkers` in
 * markdown-utils.ts); it only ever runs on the non-collaborative path, so this
 * is the same rule applied where the collaborative path actually parses.
 *
 * Callouts deliberately have no case here. Their marker line carries a type and
 * an optional title that this schema cannot hold — `> [!note]` and `> [!tip]`
 * are not among the four values `calloutConfig` allows, and a title after the
 * marker moves onto its own line on the way back out. Parsing them would
 * rewrite `> [!note]` as `> [!info]` in every Obsidian vault; left alone they
 * stay quote blocks and their bytes stay untouched.
 */
function parseCustomBlockMarkerLine(line: string): Block | null {
  // Matched exactly the way the renderer matches (markdown-utils.ts): `file` on
  // the trimmed line, the two image markers on the raw one. Trimming those two
  // as well would claim a marker indented under a list item, dropping the
  // nesting the parent preserved — and would make the same file parse to a
  // different document depending on which process read it.
  const trimmed = line.trim()
  if (FILE_BLOCK_LINE_REGEX.test(trimmed)) {
    const props = parseFileBlockMarker(trimmed)
    if (props) return { type: 'file', props } as unknown as Block
  }

  const embed = line.match(EMBED_LINE_REGEX)
  if (embed) {
    const videoId = extractYouTubeVideoId(embed[1])
    // A non-YouTube `![embed](…)` has no video to play; it stays an image.
    if (videoId) {
      return { type: 'youtubeEmbed', props: { videoId, videoUrl: embed[1] } } as unknown as Block
    }
  }

  const bookmark = line.match(BOOKMARK_LINE_REGEX)
  if (bookmark) {
    const url = bookmark[1]
    // `![bookmark](assets/photo.png)` is someone's image with an unlucky alt
    // text, not a bookmark card. The embed branch has `extractYouTubeVideoId`
    // for the same reason; this is its counterpart.
    const parsed = parseHttpUrl(url)
    if (parsed) {
      return {
        type: 'bookmark',
        props: { url, domain: parsed.hostname.replace(/^www\./, '') }
      } as unknown as Block
    }
  }

  return null
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
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
