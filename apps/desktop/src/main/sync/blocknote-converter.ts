import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { type Block, type PartialBlock } from '@blocknote/core'
import { createMemrySchema } from '@memry/editor-schema'
import { codeBlockOptions } from '@blocknote/code-block'
import {
  BOOKMARK_LINE_REGEX,
  EMBED_LINE_REGEX,
  FILE_BLOCK_LINE_REGEX,
  parseFileBlockMarker,
  readCalloutRun,
  readStructuredQuoteRun,
  resolveCalloutRun,
  resolveQuoteRun,
  serializeQuoteBlock,
  serializeToggleBlock,
  splitMarkdownByToggles,
  type ToggleBlockSegment
} from '@memry/editor-schema/blocks'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import { extractYouTubeVideoId } from '@memry/shared/youtube'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  parseCriticMarkup,
  readCriticMarkupMarksFromYDoc,
  writeCriticMarkupMarksToYDoc
} from '@memry/shared'
import {
  normalizeTaskBlocks,
  serializeTaskBlock,
  type TaskBlockProps
} from '@memry/shared/task-block'
import {
  type BlockColors,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import {
  type MarkedBlock,
  type SidecarPatch,
  parseSidecarMarkerLine,
  sidecarMarkerLines
} from '@memry/shared/block-markers'
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
import { createFenceTracker, listCodeFenceInfoStrings } from '@memry/shared/markdown-fences'
import {
  readLinkReferencesFromYDoc,
  restoreLinkReferences,
  stripLinkReferenceDefinitions,
  writeLinkReferencesToYDoc
} from '@memry/shared/link-references'
import {
  readMarkdownSourceFromYDoc,
  restoreMarkdownSource,
  writeMarkdownSourceToYDoc
} from '@memry/shared/markdown-source'
import { NOTE_SYNC_MAX_BYTES } from '@memry/sync-client/note-size'
import { createLogger } from '../lib/logger'
import { resolveVaultEmbeds } from '../vault/resolve-embed'

const log = createLogger('BlockNoteConverter')

// The same factory the renderer builds its schema from, so this process cannot
// lack a node type the renderer can author. That symmetry is the whole fix:
// y-prosemirror answers an unknown node name by DELETING the element from the
// shared Y.Doc, so a spec registered on one side only replicates as data loss.
// Main supplies serialization-only implementations — nothing here ever renders.
const serverSchema = createMemrySchema({
  // Kept on the highlighting options main has always built with, so this
  // process's markdown output is provably unchanged by #2032. Main runs in
  // Node, where the bytes cost nothing.
  codeBlock: codeBlockOptions,
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

/**
 * What became of the author's bytes on one serialization. `no-record` is by
 * design: the file was already in house style, or predates the record. The
 * `house-style` outcomes with a record present are the degraded cases and
 * are logged as such, so a lookup that silently misses can be told apart
 * from a note that never had a record.
 */
export type SourceRestoreOutcome =
  'no-record' | 'critic-marks' | 'source' | 'merged' | 'house-style-fallback' | 'house-style-threw'

export interface YDocToMarkdownOptions {
  /**
   * The note's vault-relative path, so the proof parse resolves embeds the way
   * the seed did. Without it a `![[photo.png]]` line resolves differently,
   * the proof fails, and the note keeps house style — degraded, not wrong.
   */
  notePath?: string
  /** Reported once per call, after the outcome is known. */
  onSourceRestore?: (outcome: SourceRestoreOutcome) => void
}

/**
 * The bytes the vault file should hold for this document.
 *
 * The document alone serializes to house style (`serializeCanonical`). When
 * it was seeded from a file spelled differently, the author's bytes ride
 * beside it (#1915) and come back for every region the document has not
 * changed since — proven by re-parsing the merged text and demanding it
 * canonicalize to exactly what the document says now. A document carrying
 * CriticMarkup marks keeps house style: those marks are byte offsets into the
 * serialized text, and restoring the author's spelling would move them.
 */
export async function yDocToMarkdown(
  doc: Y.Doc,
  fragmentName: string = CRDT_FRAGMENT_NAME,
  options: YDocToMarkdownOptions = {}
): Promise<string | null> {
  const canonical = await serializeCanonical(doc, fragmentName)
  if (canonical === null) return null

  const report = (outcome: SourceRestoreOutcome): string => {
    options.onSourceRestore?.(outcome)
    return canonical
  }

  const source = readMarkdownSourceFromYDoc(doc)
  if (source === null) return report('no-record')
  if (readCriticMarkupMarksFromYDoc(doc).length > 0) return report('critic-marks')

  try {
    const restored = await restoreMarkdownSource(canonical, source, (markdown) =>
      canonicalMarkdown(markdown, options.notePath)
    )
    if (restored === source) {
      options.onSourceRestore?.('source')
      return restored
    }
    if (restored !== canonical) {
      options.onSourceRestore?.('merged')
      return restored
    }
    // A record was there and the merge could not be proven, or was not
    // available: the file gets house style. Expected now and then, but never
    // silently — this is the line that tells a lookup miss from a design choice.
    log.warn('Source record present but not restorable, writing house style', {
      notePath: options.notePath,
      sourceBytes: source.length,
      canonicalBytes: canonical.length
    })
    return report('house-style-fallback')
  } catch (err) {
    log.error('Restoring the source spelling failed, writing house style', err)
    return report('house-style-threw')
  }
}

/**
 * The markdown a body canonicalizes to: what a document seeded from it would
 * serialize to with no source record. The proof oracle for the merge above.
 */
async function canonicalMarkdown(markdown: string, notePath?: string): Promise<string | null> {
  const scratch = new Y.Doc()
  const ok = await seedFragment(markdown, scratch.getXmlFragment(CRDT_FRAGMENT_NAME), notePath, {
    recordSource: false
  })
  if (!ok) return null
  return serializeCanonical(scratch, CRDT_FRAGMENT_NAME)
}

/** House style: the document re-derived into markdown, nothing of the source kept. */
export async function yDocToCanonicalMarkdown(
  doc: Y.Doc,
  fragmentName: string = CRDT_FRAGMENT_NAME
): Promise<string | null> {
  return serializeCanonical(doc, fragmentName)
}

async function serializeCanonical(doc: Y.Doc, fragmentName: string): Promise<string | null> {
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
    const body = await blocksToMarkdownPreserving(editor, blocks as Block[])
    const references = readLinkReferencesFromYDoc(doc)
    return restoreLinkReferences(body, references.definitions, references.usages)
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
    const blocks = await markdownToBlocksPreserving(editor, markdown, notePath)
    restoreUntaggedFenceLanguages(markdown, blocks)
    return blocks
  } catch (err) {
    log.error('Markdown-to-blocks conversion failed', err)
    return null
  }
}

/**
 * Un-invent the language BlockNote stamps on a fence that carried none.
 *
 * A bare ``` ``` ``` parses to a `codeBlock` whose `language` is the schema
 * default, `javascript`, and the source is the only place that still knows the
 * author left it bare. So the fences are counted off the markdown and matched
 * against the code blocks in document order — the same order both are written
 * in — and only the invented language is cleared. A count mismatch means some
 * fence did not become a code block (a declined toggle body, an unclosed
 * fence), and the whole pass is abandoned rather than guessed at: today's
 * wrong language is better than a language moved onto the wrong block.
 */
function restoreUntaggedFenceLanguages(markdown: string, blocks: Block[]): void {
  const infoStrings = listCodeFenceInfoStrings(markdown)
  if (!infoStrings.includes('')) return

  const codeBlocks: Block[] = []
  const visit = (list: Block[]): void => {
    for (const block of list) {
      if (block.type === 'codeBlock') codeBlocks.push(block)
      visit((block.children ?? []) as Block[])
    }
  }
  visit(blocks)

  if (codeBlocks.length !== infoStrings.length) return
  for (const [index, info] of infoStrings.entries()) {
    if (info === '') (codeBlocks[index].props as { language: string }).language = ''
  }
}

// BlockNote's headless serializer regenerates a MISSING block id but writes an
// explicit empty-string id as-is. An empty id then trips the renderer's block
// resolver ("Block doesn't have id") and crashes the editor. Stamp a real id on
// any block whose id is falsy before serializing.
function ensureBlockIds(blocks: Block[]): void {
  for (const block of blocks) {
    if (!block.id) (block as { id: string }).id = crypto.randomUUID()
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
        el.setAttribute('id', crypto.randomUUID())
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
  return seedFragment(markdown, fragment, notePath, { recordSource: true })
}

export interface PreparedFragmentSeed {
  blocks: Block[]
  marks: ReturnType<typeof parseCriticMarkup>['marks']
  definitions: ReturnType<typeof stripLinkReferenceDefinitions>['definitions']
  usages: ReturnType<typeof stripLinkReferenceDefinitions>['usages']
  plainText: string
}

/**
 * Parse markdown into everything a fragment seed needs to write, without
 * touching the Y.Doc. Shared by the initial seed (`markdownToYFragment`) and
 * the external-edit door (`replaceNoteBodyInCrdt`), so both refresh the same
 * side channels — link references (#1909) and CriticMarkup marks — instead of
 * only the one that happens to parse the fragment itself.
 */
export async function prepareFragmentSeed(
  markdown: string,
  notePath: string | undefined
): Promise<PreparedFragmentSeed | null> {
  const parsed = parseCriticMarkup(markdown)
  // Reference definitions ride beside the document in two Y.Arrays: the editor
  // has no block for one, so the definition is dropped and the destination
  // inlined at every use site, and the arrays are what puts both back (#1909).
  // The parse still sees the definitions — without them `[docs][d]` is literal
  // bracket text to CommonMark, not a link, and the note would open with every
  // reference link dead on screen.
  const references = stripLinkReferenceDefinitions(parsed.plainText)
  const blocks = await markdownToBlocks(parsed.plainText, notePath)
  if (!blocks) return null
  // Upgrade `- [ ] … {task:id}` checkboxes into taskBlock nodes so the renderer
  // binds the custom block on first paint instead of a raw checkbox.
  const normalized = normalizeTaskBlocks(blocks).blocks
  return {
    blocks: normalized,
    marks: parsed.marks,
    definitions: references.definitions,
    usages: references.usages,
    plainText: parsed.plainText
  }
}

/**
 * Synchronous write half of a fragment seed: replaces the fragment's blocks
 * and both side-channel arrays. Safe to call on an already-empty fragment
 * (the initial seed) or to wrap in a `doc.transact` alongside clearing an
 * existing fragment (a replace).
 */
export function applyFragmentSeed(
  prepared: PreparedFragmentSeed,
  fragment: Y.XmlFragment
): boolean {
  const ok = blocksToYFragment(prepared.blocks, fragment)
  if (ok && fragment.doc) {
    writeCriticMarkupMarksToYDoc(fragment.doc, prepared.marks)
    writeLinkReferencesToYDoc(fragment.doc, prepared.definitions, prepared.usages)
  }
  return ok
}

async function seedFragment(
  markdown: string,
  fragment: Y.XmlFragment,
  notePath: string | undefined,
  options: { recordSource: boolean }
): Promise<boolean> {
  const prepared = await prepareFragmentSeed(markdown, notePath)
  if (!prepared) return false
  const ok = applyFragmentSeed(prepared, fragment)
  if (ok && fragment.doc && options.recordSource) {
    // The source at the layer `yDocToMarkdown` returns: CriticMarkup already
    // stripped, definitions still where the author put them.
    await recordMarkdownSourceInYDoc(fragment.doc, prepared.plainText, fragmentNameOf(fragment))
  }
  return ok
}

/**
 * How much of the pushable snapshot (`NOTE_SYNC_MAX_BYTES`, the encrypt-time
 * cap net of base64 growth) a freshly seeded doc plus its source record may
 * occupy. Past that cap the push throws before any request, dead-letters the
 * queue row, and no toast reaches the user (#1465), so a note that crosses it
 * stops syncing silently; any byte this record adds moves a note toward it.
 * Half, because the rest is headroom for the update history a doc in use
 * accumulates between compactions. Measured on a foreign note whose fragment
 * holds inline marks (`* One`, `_em_`, four-space nesting): the bare fragment
 * is ~2.9x the markdown bytes and the source adds ~1.0x, so the record is
 * kept for files up to ~480 KB and larger ones stay in house style, as before.
 */
export const MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES = Math.floor(NOTE_SYNC_MAX_BYTES / 2)

/**
 * Remember what the document was just built from (#1915), so the write-back
 * can give the author's spelling back for whatever it does not change. Stores
 * nothing when the source already is house style, which is every file this
 * app wrote itself, and nothing when the doc plus the source would not fit
 * the snapshot budget above. Every markdown → fragment door calls this; the
 * seed above does, and `replaceNoteBodyInCrdt` does after an external edit,
 * since a stale record can only cost style, never meaning, but costs it
 * every save.
 */
export async function recordMarkdownSourceInYDoc(
  doc: Y.Doc,
  source: string,
  fragmentName: string = CRDT_FRAGMENT_NAME
): Promise<void> {
  const canonical = await serializeCanonical(doc, fragmentName)
  if (canonical === null || canonical === source) {
    writeMarkdownSourceToYDoc(doc, null)
    return
  }
  const docBytes = Y.encodeStateAsUpdate(doc).byteLength
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  if (docBytes + sourceBytes > MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES) {
    writeMarkdownSourceToYDoc(doc, null)
    log.info('Source record skipped: doc plus source would exceed the snapshot budget', {
      fragmentName,
      docBytes,
      sourceBytes,
      budgetBytes: MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES
    })
    return
  }
  writeMarkdownSourceToYDoc(doc, source)
}

function fragmentNameOf(fragment: Y.XmlFragment): string {
  for (const [name, type] of fragment.doc?.share ?? []) {
    if (Object.is(type, fragment)) return name
  }
  return CRDT_FRAGMENT_NAME
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
    id: crypto.randomUUID(),
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
 * Toggle blocks own their whole subtree on disk: children go INSIDE the
 * `<details>`, serialized by the same top-level walk, so nested toggles, images
 * and blank-line gaps inside a toggle behave exactly as they do on a page.
 *
 * The toggle's own line is serialized as a paragraph, not as itself: BlockNote
 * writes a `toggleListItem` as a plain `<li>`, which would put a stray `- `
 * inside the `<summary>`. Byte-identical to the renderer's `serializeToggle`.
 */
async function serializeToggle(editor: ServerBlockNoteEditor, block: Block): Promise<string> {
  // `open` comes off with the type: BlockNote compares every prop against the
  // target block's propSchema, and a paragraph has no `open` to compare with —
  // it throws there, which returns null for the whole document.
  const { open: isOpen, ...summaryProps } = block.props as { open?: boolean }
  const summaryBlock = {
    ...block,
    type: 'paragraph',
    props: summaryProps,
    children: []
  } as unknown as PartialBlock
  const summary = (await serializeBlocks(editor, [summaryBlock])).trim()
  const children = (block.children ?? []) as Block[]
  const body = children.length > 0 ? await blocksToMarkdownPreserving(editor, children) : ''
  const colors = block.props as BlockColors
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
 *
 * The quote's own line is serialized as a paragraph, the same trick
 * `serializeToggle` uses: a `quote` serialized alone already carries the `> `
 * this function is about to add.
 */
async function serializeQuote(editor: ServerBlockNoteEditor, block: Block): Promise<string> {
  const own = { ...block, type: 'paragraph', props: {}, children: [] } as unknown as Block
  const children = (block.children ?? []) as Block[]
  const inner = await blocksToMarkdownPreserving(editor, [own, ...children])
  return serializeQuoteBlock(inner.trim())
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
  const blocks = await parseMaskedMarkdown(editor, text)

  return applyInlineColorTokens(blocks as never[], spans) as Block[]
}

/**
 * Twin of the renderer's `parseMaskedMarkdown` (markdown-utils.ts).
 *
 * Toggle regions come off FIRST, before the blank-line and marker-line
 * scanners: those read one line at a time and would shred a toggle body apart
 * at its own paragraph gaps. Each body re-enters this function, so a toggle
 * nested inside a toggle works at any depth, images and all.
 */
async function parseMaskedMarkdown(
  editor: ServerBlockNoteEditor,
  markdown: string
): Promise<Block[]> {
  const blocks: Block[] = []

  for (const segment of splitMarkdownByToggles(markdown)) {
    if (segment.kind === 'toggle') {
      blocks.push(await parseToggleSegment(editor, segment))
    } else if (segment.kind === 'gap') {
      // Blank lines the user left at a toggle's edge. Same currency, and the
      // same empty paragraphs, as a gap the blank-line scanner finds inside a
      // markdown segment (#1877).
      for (let i = 0; i < segment.extraLines; i++) {
        blocks.push(createEmptyParagraph())
      }
    } else {
      blocks.push(...(await parseMarkdownWithoutToggles(editor, segment.text)))
    }
  }

  return blocks
}

async function parseToggleSegment(
  editor: ServerBlockNoteEditor,
  segment: ToggleBlockSegment
): Promise<Block> {
  const parsedSummary = await editor.tryParseMarkdownToBlocks(segment.summary)
  const colors = segment.colorsMarker ? parseBlockColorsMarker(segment.colorsMarker) : null

  return {
    type: 'toggleListItem',
    id: crypto.randomUUID(),
    props: { ...(colors ?? {}), open: segment.open },
    content: parsedSummary[0]?.content ?? [],
    children: segment.body ? await parseMaskedMarkdown(editor, segment.body) : []
  } as unknown as Block
}

async function parseMarkdownWithoutToggles(
  editor: ServerBlockNoteEditor,
  markdown: string
): Promise<Block[]> {
  const segments = splitMarkdownPreservingBlanks(markdown)
  const blocks: Block[] = []

  for (const seg of segments) {
    if (seg.type === 'content') {
      blocks.push(...(await parseContentWithMarkers(editor, seg.text)))
    } else {
      for (let i = 0; i < seg.extraLines; i++) {
        blocks.push(createEmptyParagraph())
      }
    }
  }

  return blocks
}

async function parseContentWithMarkers(
  editor: ServerBlockNoteEditor,
  text: string
): Promise<Block[]> {
  const blocks: Block[] = []
  let buffer: string[] = []
  let pending: SidecarPatch[] = []

  const applyPending = (block: Block | undefined): void => {
    if (block) for (const apply of pending) apply(block as unknown as MarkedBlock)
    pending = []
  }

  const flushBuffer = async (): Promise<void> => {
    if (buffer.length === 0) return
    const parsed = await parseMarkdownChunkPreservingNesting(editor, buffer.join('\n'))
    applyPending(parsed[0])
    blocks.push(...parsed)
    buffer = []
  }

  const fence = createFenceTracker()
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // A marker inside a code fence is the author's text, not a marker.
    const insideFence = fence.consume(line)

    // Callouts are claimed here ONLY in the exact shapes this feature owns —
    // see parseCalloutRunAt. Everything else `> `-prefixed stays a quote block
    // and its bytes stay untouched, which is what keeps `> [!note]` in an
    // Obsidian vault byte-identical through Memry.
    if (!insideFence) {
      const afterSidecarMarker = buffer.length === 0 && pending.length > 0
      const atParagraphStart = i === 0 || lines[i - 1].trim() === '' || afterSidecarMarker
      const claimed = await parseCalloutRunAt(editor, lines, i, atParagraphStart)
      if (claimed) {
        await flushBuffer()
        const callout = {
          type: 'callout',
          props: { type: claimed.type },
          content: claimed.content
        } as unknown as Block
        applyPending(callout)
        blocks.push(callout)
        for (let consumed = i + 1; consumed < claimed.end; consumed++) {
          fence.consume(lines[consumed])
        }
        i = claimed.end - 1
        continue
      }

      const quoted = atParagraphStart ? await parseQuoteRunAt(editor, lines, i) : null
      if (quoted) {
        await flushBuffer()
        const quote = {
          type: 'quote',
          props: {},
          content: quoted.content,
          children: quoted.children
        } as unknown as Block
        applyPending(quote)
        blocks.push(quote)
        for (let consumed = i + 1; consumed < quoted.end; consumed++) {
          fence.consume(lines[consumed])
        }
        i = quoted.end - 1
        continue
      }
    }

    // Deliberately NOT fence-guarded: this branch predates custom-block parsing
    // and guarding it would drop a sidecar marker that follows a fence this
    // tracker read differently, which is data loss on a path #1432 never
    // touched. The renderer's twin (markdown-utils.ts) is unguarded too.
    const patch = parseSidecarMarkerLine(trimmed)
    if (patch) {
      await flushBuffer()
      pending.push(patch)
      continue
    }

    const marker = insideFence ? null : parseCustomBlockMarkerLine(line)
    if (marker) {
      await flushBuffer()
      pending = []
      blocks.push(marker)
      continue
    }

    buffer.push(line)
  }
  await flushBuffer()

  return blocks
}

/**
 * Claim a callout at `lines[i]`, or null to leave the bytes alone.
 *
 * The claim is proven, not pattern-matched: `resolveCalloutRun` re-serializes
 * the body and claims only when `serializeCalloutBlock` would write the run
 * back byte-for-byte. `> [!note]`, `> [!tip]`, a title after the marker, a
 * blank `>` line, a list in the body — all decline and stay quote blocks with
 * their bytes untouched, which is the Obsidian-vault guarantee the old
 * "never parse callouts" rule existed to protect (#1846). What that rule cost
 * was every Memry callout on this path: seeding a doc from the vault file
 * demoted `> [!info]` to a quote block, the editor lost the callout UI, and
 * the marker eventually tore away from its body as plain text.
 *
 * The bare `[!info]`-plus-body shape is the already-torn form of that damage;
 * `readCalloutRun` heals it only at a paragraph start with the body directly
 * below, so a lone `[!info]` someone typed as text stays text.
 */
async function parseCalloutRunAt(
  editor: ServerBlockNoteEditor,
  lines: readonly string[],
  i: number,
  atParagraphStart: boolean
): Promise<{ type: string; content: unknown; end: number } | null> {
  const run = readCalloutRun(lines, i, atParagraphStart)
  if (!run) return null

  const claimed = await resolveCalloutRun(
    run,
    async (md) => (await editor.tryParseMarkdownToBlocks(md)) as never[],
    async (block) => serializeBlocks(editor, [block as PartialBlock])
  )
  if (!claimed) return null

  return { type: claimed.type, content: claimed.content, end: run.end }
}

/**
 * Claim a structured blockquote at `lines[i]`, or null to leave the bytes on
 * BlockNote's own quote path.
 *
 * Only the two shapes BlockNote's flat quote block loses are read (a blank `>`
 * separator, a `> >` nesting level), and even those only when re-serializing
 * the parse reproduces the run byte-for-byte — see `resolveQuoteRun`. The
 * claimed run becomes a quote block that owns its later blocks as children,
 * which `serializeQuote` writes back inside the blockquote.
 *
 * Inner blocks are parsed flat, so a quote nested two levels deep declines and
 * keeps today's behavior rather than round-tripping through a half-applied
 * nesting.
 */
async function parseQuoteRunAt(
  editor: ServerBlockNoteEditor,
  lines: readonly string[],
  i: number
): Promise<{ content: unknown; children: Block[]; end: number } | null> {
  const run = readStructuredQuoteRun(lines, i)
  if (!run) return null

  const claimed = await resolveQuoteRun(
    run,
    async (md) => (await editor.tryParseMarkdownToBlocks(md)) as never[],
    async (parsed) => serializeBlocks(editor, parsed as PartialBlock[])
  )
  if (!claimed) return null

  return { content: claimed.content, children: claimed.children as Block[], end: run.end }
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
 * Callouts have no case here because their form spans lines; they are claimed
 * by `parseCalloutRunAt` in the caller's line loop, under the byte-round-trip
 * guard documented there.
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
    const markers = sidecarMarkerLines(block as unknown as MarkedBlock)

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
    } else if ((block.type as string) === 'toggleListItem') {
      await flushContentGroup()
      flushGap()
      segments.push({ type: 'content', text: await serializeToggle(editor, block) })
    } else if (isStructuredQuote(block)) {
      await flushContentGroup()
      flushGap()
      const quoted = await serializeQuote(editor, block)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${quoted}` : quoted
      })
    } else if (isEmptyParagraph(block)) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup as PartialBlock[])
        segments.push({ type: 'content', text: md.trim() })
        contentGroup = []
      }
      emptyCount++
    } else if (markers.length > 0) {
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
        text: `${markers.join('\n')}\n${blockMd.trim()}`
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
