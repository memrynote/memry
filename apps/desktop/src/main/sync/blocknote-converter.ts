import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { type Block, type PartialBlock } from '@blocknote/core'
import { createMemrySchema } from '@memry/editor-schema'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import {
  normalizeDateMentions,
  normalizeLinkMentions,
  writeHtmlCommentTokens
} from '@memry/editor-schema/inline'
import { parseNoteMarkdown } from '@memry/editor-schema/note-markdown'
import {
  serializeFileBlock,
  type FileBlockProps,
  serializeCalloutBlock,
  serializeMathBlock,
  serializeQuoteOfBlocks,
  serializeToggleBlock,
  serializeColumnListBlock
} from '@memry/editor-schema/blocks'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  decodeWritingMarkers,
  encodeWritingBody,
  parseCriticMarkup,
  readCriticMarkupMarksFromYDoc,
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  stripWritingSentinels,
  withoutWritingSentinels,
  writeCriticMarkupMarksToYDoc,
  type CriticMarkupMark,
  type WritingFrontmatter,
  type WritingSentinelMap
} from '@memry/shared'
import { normalizeTaskBlocks, serializeTaskBlockTree } from '@memry/shared/task-block'
import { normalizePlainCheckboxes, withPlainCheckboxMarkers } from '@memry/shared/plain-checkbox'
import {
  type BlockColors,
  hasNonDefaultColors,
  serializeBlockColorsMarker
} from '@memry/shared/block-colors'
import { sidecarMarkerLines } from '@memry/shared/block-markers'
import { hideBacktickLanguages, spellBacktickLanguages } from '@memry/shared/code-fence-language'
import { extractInlineColorRuns, restoreInlineColorTokens } from '@memry/shared/inline-colors'
import { withoutStaleMaskTokens } from '@memry/shared/stale-mask-tokens'
import {
  assembleMarkdownWithBlanks,
  extractWikiImageEmbedRefs,
  rewriteWikiImageEmbeds,
  normalizeSerializedMarkdown,
  type MarkdownSegment
} from '@memry/shared/empty-lines'
import {
  legacyReading,
  parseDroppingHtmlComments,
  parseWithLegacyBlocks,
  parseWithLegacyHtml,
  parseMarkdownToBlocks,
  parsesHtmlComments,
  readsLiteralHtml,
  readsLosslessBlocks
} from './blocknote-parse-breaks'
import { createBlockNestingMarker } from '@memry/shared/block-nesting'
import {
  inlineLinkReferences,
  readLinkReferencesFromYDoc,
  restoreLinkReferences,
  stripLinkReferenceDefinitions,
  writeLinkReferencesToYDoc
} from '@memry/shared/link-references'
import {
  readMarkdownSourceRecordFromYDoc,
  restoreMarkdownSource,
  writeMarkdownSourceToYDoc
} from '@memry/shared/markdown-source'
import { maskHtmlComments } from '@memry/shared/html-comments'
import { NOTE_SYNC_MAX_BYTES } from '@memry/sync-client/note-size'
import { createLogger } from '../lib/logger'
import {
  applyWritingSeed,
  insertWritingSentinels,
  type EncodedWritingRanges
} from './writing-markdown'

const log = createLogger('BlockNoteConverter')

// The same factory the renderer builds its schema from, so this process cannot
// lack a node type the renderer can author. That symmetry is the whole fix:
// y-prosemirror answers an unknown node name by DELETING the element from the
// shared Y.Doc, so a spec registered on one side only replicates as data loss.
// Main supplies serialization-only implementations — nothing here ever renders.
const serverSchema = createMemrySchema({
  // The same highlighting options the renderer builds with, so a fence
  // language one side accepts is a language the other can serialize. Main runs
  // in Node, where the bytes cost nothing.
  codeBlock: memryCodeBlockOptions,
  blocks: createServerBlockSpecs(),
  inline: createServerInlineSpecs()
})

/**
 * How long the server editor outlives its last use. Each editor owns a JSDOM
 * window, and conversions come in bursts (a note open, a write-back, a sync
 * pull), so the editor is dropped once a burst is over and rebuilt from the
 * same schema on the next one. The rebuilt editor converts identically; only
 * the first conversion after a release pays the construction cost again.
 */
export const SERVER_EDITOR_IDLE_RELEASE_MS = 3 * 60_000

let serverEditor: ServerBlockNoteEditor | null = null
let serverEditorReleaseTimer: ReturnType<typeof setTimeout> | null = null

function getEditor(): ServerBlockNoteEditor {
  if (!serverEditor) {
    // The custom taskBlock adds a key absent from the default block schema, so
    // the create() return type no longer matches the default-parameterised
    // `ServerBlockNoteEditor`. The extra block only matters at runtime (for
    // (de)serialization); erase it from the type so the existing default-typed
    // helpers keep working.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
    serverEditor = ServerBlockNoteEditor.create({ schema: serverSchema }) as ServerBlockNoteEditor
  }
  // Re-armed on every use. A conversion still running when the timer fires
  // keeps the editor it was handed; the release only stops new ones from
  // reusing it.
  if (serverEditorReleaseTimer) clearTimeout(serverEditorReleaseTimer)
  serverEditorReleaseTimer = setTimeout(() => {
    serverEditorReleaseTimer = null
    serverEditor = null
  }, SERVER_EDITOR_IDLE_RELEASE_MS)
  serverEditorReleaseTimer.unref?.()
  return serverEditor
}

/**
 * What became of the author's bytes on one serialization. `no-record` is by
 * design: the file was already in house style, or predates the record. The
 * `house-style` outcome with a record present is the degraded case and is
 * logged as such, so a lookup that silently misses can be told apart from a
 * note that never had a record. `file` and `file-merged` are the record
 * failing and the note's file standing in for it (#2615). `restore-threw` and
 * `file-unreadable` resolve the call to null: the caller keeps the file.
 */
export type SourceRestoreOutcome =
  | 'no-record'
  | 'critic-marks'
  | 'writing-marks'
  | 'source'
  | 'merged'
  | 'file'
  | 'file-merged'
  | 'file-unreadable'
  | 'house-style-fallback'
  | 'restore-threw'

export interface YDocToMarkdownOptions {
  /**
   * The note's vault-relative path, so the proof parse resolves embeds the way
   * the seed did. Without it a `![[photo.png]]` line resolves differently,
   * the proof fails, and the note keeps house style — degraded, not wrong.
   */
  notePath?: string
  /**
   * The body the note's file holds now. Read only when the record cannot be
   * restored, to restore the author's spelling from the file instead. A read
   * or parse that throws resolves the call to null, so the caller keeps the
   * file rather than writing house style over bytes it could not read.
   */
  readFileBody?: () => Promise<string | null>
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

  const record = readMarkdownSourceRecordFromYDoc(doc)
  if (record === null) return report('no-record')
  if (readCriticMarkupMarksFromYDoc(doc).length > 0) return report('critic-marks')

  const { source } = record
  // A record from before #2741 sits beside a document whose parse dropped
  // every comment, so the source is read the same way, and the merge takes
  // the comments from the source like any other unchanged region (BBF-29).
  // A record from before lossless blocks sits beside tables cut and quotes
  // flattened the old way: read the same way, a cut row or a flat quote is
  // unchanged and keeps the file's bytes. One from before raw HTML stayed text
  // sits beside a document that dropped `<kbd>` and `<sup>`, so the source is
  // read as text only if the document kept it so.
  const canonicalize = (markdown: string): Promise<string | null> => {
    const parse = (): Promise<string | null> => canonicalMarkdown(markdown, options.notePath)
    const html = record.literalHtml ? parse : () => parseWithLegacyHtml(parse)
    const blocks = record.losslessBlocks ? html : () => parseWithLegacyBlocks(html)
    return record.htmlComments ? blocks() : parseDroppingHtmlComments(blocks)
  }
  try {
    const restored = await restoreMarkdownSource(canonical, source, canonicalize)
    if (restored === source) {
      options.onSourceRestore?.('source')
      return restored
    }
    if (restored !== canonical) {
      options.onSourceRestore?.('merged')
      return restored
    }
    const fromFile = await restoreFileSpelling(canonical, options.readFileBody, canonicalize)
    if (fromFile?.outcome === 'file-unreadable') {
      log.error('Source record not restorable and the file could not be read, keeping it', {
        notePath: options.notePath,
        error: fromFile.error
      })
      options.onSourceRestore?.('file-unreadable')
      return null
    }
    if (fromFile) {
      log.info('Source record not restorable, kept the spelling of the file', {
        notePath: options.notePath,
        outcome: fromFile.outcome
      })
      options.onSourceRestore?.(fromFile.outcome)
      return fromFile.markdown
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
    log.error('Restoring the source spelling failed, keeping the file', err)
    options.onSourceRestore?.('restore-threw')
    return null
  }
}

/**
 * The author's spelling restored from the note's file, for a doc whose record
 * no longer describes it (#2615). The file is the copy the last write left, so
 * an unchanged doc keeps it byte for byte and an edit lands in its spelling.
 * Read at the layer the record holds, without writing tools markers or
 * CriticMarkup, so markup the doc has dropped does not come back. Null when
 * there is no file or its spelling cannot be kept either.
 */
async function restoreFileSpelling(
  canonical: string,
  readFileBody: (() => Promise<string | null>) | undefined,
  canonicalize: (markdown: string) => Promise<string | null>
): Promise<
  | { outcome: 'file' | 'file-merged'; markdown: string }
  | { outcome: 'file-unreadable'; error: unknown }
  | null
> {
  if (!readFileBody) return null
  try {
    const body = await readFileBody()
    if (body === null) return null
    const decoded = decodeWritingMarkers(withLfLineEndings(body))
    const file = withoutWritingSentinels(
      parseCriticMarkup(decoded.text),
      decoded.sentinels
    ).plainText
    const restored = await restoreMarkdownSource(canonical, file, canonicalize)
    if (restored === canonical) return null
    return { markdown: restored, outcome: restored === file ? 'file' : 'file-merged' }
  } catch (error) {
    return { outcome: 'file-unreadable', error }
  }
}

/**
 * The file body of a doc that holds alternatives or ghosts: house style with
 * the writing tools markers in place and the CriticMarkup marks applied around
 * them. `placeCriticMarks` gets the body's text without the markers and
 * returns the marks placed in it. House style, as with CriticMarkup: the
 * markers are placed by the serializer, and restoring the author's spelling
 * around them is not something the merge can prove. Resolves undefined when no
 * range resolves any more (the caller serializes as usual), null when
 * conversion failed.
 */
export async function yDocToMarkdownWithWritingRanges(
  doc: Y.Doc,
  fragmentName: string,
  placeCriticMarks: (plain: string) => CriticMarkupMark[],
  options: YDocToMarkdownOptions = {}
): Promise<
  { markdown: string; alternatives: EncodedWritingRanges['alternatives'] } | null | undefined
> {
  const alternatives = readWritingAlternativesFromYDoc(doc)
  const ghosts = readWritingGhostsFromYDoc(doc)
  if (alternatives.length === 0 && ghosts.length === 0) return undefined
  let encoded: EncodedWritingRanges | null = null
  const text = await serializeCanonical(doc, fragmentName, (snapshot) => {
    encoded = insertWritingSentinels(snapshot, fragmentName, alternatives, ghosts)
  })
  if (text === null) return null
  const ranges = encoded as EncodedWritingRanges | null
  if (!ranges || ranges.sentinels.size === 0) return undefined
  options.onSourceRestore?.('writing-marks')
  return {
    markdown: encodeWritingBody(
      text,
      ranges.sentinels,
      placeCriticMarks(stripWritingSentinels(text, ranges.sentinels))
    ),
    alternatives: ranges.alternatives
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

async function serializeCanonical(
  doc: Y.Doc,
  fragmentName: string,
  prepareSnapshot?: (snapshot: Y.Doc) => void
): Promise<string | null> {
  try {
    // y-prosemirror's `createNodeFromYElement` DELETES any element it cannot
    // build (dist/y-prosemirror.cjs:878-885) — a repair heuristic that, run on
    // the live doc, turns a serialization gap into replicated data loss. Read
    // from a detached copy so this path can only ever read.
    const snapshot = new Y.Doc()
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc))
    prepareSnapshot?.(snapshot)
    const editor = getEditor()
    // A token an older build left in a string of the document is no use to this
    // process, which cannot decode another's word, and would be written into
    // the file. Dropped before this process makes tokens of its own.
    const blocks = withoutStaleMaskTokens(
      editor.yXmlFragmentToBlocks(snapshot.getXmlFragment(fragmentName))
    )
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
    const body = await blocksToMarkdownPreserving(editor, blocks)
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
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
    // HTML comments come off before anything splits the note into lines, so a
    // multi-line comment holding blank lines or a fence stays one comment
    // (AF-015).
    const masked = parsesHtmlComments()
      ? maskHtmlComments(markdown, { legacy: legacyReading() })
      : markdown
    return await markdownToBlocksPreserving(editor, masked, notePath)
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
    if (!block.id) (block as { id: string }).id = crypto.randomUUID()
    const children = block.children as Block[] | undefined
    if (children?.length) ensureBlockIds(children)
  }
}

/**
 * BlockNote's empty document: the one empty paragraph, with its default props,
 * that a fresh editor holds. An open editor always holds at least one block.
 */
export function emptyDocumentBlocks(): Block[] {
  return getEditor().editor.document.map((block) => ({ ...block, id: crypto.randomUUID() }))
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

export { repairEmptyBlockIds } from './repair-block-ids'

/**
 * `writing` is the note's `writing` frontmatter. Pass it whenever the whole
 * file is at hand (an empty value when the key is absent); undefined means
 * only the body is known, and versions and overflow stay as the doc has them.
 */
export async function markdownToYFragment(
  markdown: string,
  fragment: Y.XmlFragment,
  notePath?: string,
  writing?: WritingFrontmatter
): Promise<boolean> {
  return seedFragment(markdown, fragment, notePath, { recordSource: true, writing })
}

/**
 * The parse reads a `\r` as a space, so a CRLF file seeded as it is puts a
 * trailing space on every line of the doc. Every line then differs from the
 * source, and the first edit writes the whole note in house style (#2615).
 * The write-back puts the file's own line endings back (`serializeParsedNote`).
 */
function withLfLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n')
}

export interface PreparedFragmentSeed {
  blocks: Block[]
  marks: ReturnType<typeof parseCriticMarkup>['marks']
  definitions: ReturnType<typeof stripLinkReferenceDefinitions>['definitions']
  usages: ReturnType<typeof stripLinkReferenceDefinitions>['usages']
  /** The body with CriticMarkup and writing tools markers removed. */
  plainText: string
  /** Writing tools markers, as the sentinels the blocks now carry. */
  writingSentinels: WritingSentinelMap
  writing: WritingFrontmatter | undefined
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
  notePath: string | undefined,
  writing?: WritingFrontmatter
): Promise<PreparedFragmentSeed | null> {
  // Writing tools markers first, as sentinels that ride the parse into the
  // blocks (see sync/writing-markdown.ts). CriticMarkup offsets are then
  // moved off them, onto the text every CriticMarkup reader counts in.
  const decoded = decodeWritingMarkers(withLfLineEndings(markdown))
  const parsed = parseCriticMarkup(decoded.text)
  const critic = withoutWritingSentinels(parsed, decoded.sentinels)
  // Reference definitions ride beside the document in two Y.Arrays: the editor
  // has no block for one, so the definition is dropped and the destination
  // inlined at every use site, and the arrays are what puts both back (#1909).
  // The parse still sees the definitions — without them `[docs][d]` is literal
  // bracket text to CommonMark, not a link, and the note would open with every
  // reference link dead on screen.
  const references = stripLinkReferenceDefinitions(parsed.plainText)
  // Definitions stripped and usages resolved to inline links BEFORE the
  // editor sees the text. Up to BlockNote 0.50 this passed `parsed.plainText`
  // whole, because remark resolved the references itself and swallowed the
  // definition lines. 0.51's hand-written parser does neither, so the
  // definitions came back as literal paragraphs on top of the copy
  // `restoreLinkReferences` appends, and every open added another block of
  // them to the file.
  const source = inlineLinkReferences(references.markdown, references.usages)
  const blocks = await markdownToBlocks(source, notePath)
  if (!blocks) return null
  // Upgrade `- [ ] … {task:id}` checkboxes into taskBlock nodes so the renderer
  // binds the custom block on first paint instead of a raw checkbox. Lines
  // ending in the plain-checkbox marker become checkboxes with `plain: true`,
  // which the editor never converts.
  // `((mention:…))` and `((date:…))` become `linkMention` and `dateMention`
  // nodes here, once, in the doc every device receives. Left as text, each
  // device's editor promoted them on open, and two devices doing that before
  // they synced merged into two nodes per token (#3871). A token in an unstyled
  // run is promoted, a legacy link mention with `_ * ! ~ '` raw (#4478) and a
  // salvaged legacy date (#1845) included, and the source record keeps its
  // bytes until its paragraph is edited. A token in code or emphasis stays
  // text (#4652).
  const mentions = normalizeDateMentions(normalizeLinkMentions(blocks).blocks).blocks
  const normalized = normalizePlainCheckboxes(normalizeTaskBlocks(mentions, source).blocks).blocks
  return {
    blocks: normalized,
    marks: critic.marks,
    definitions: references.definitions,
    usages: references.usages,
    plainText: critic.plainText,
    writingSentinels: decoded.sentinels,
    writing
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
  if (ok) applyFragmentSideChannels(prepared, fragment)
  return ok
}

/** The side-channel half of `applyFragmentSeed`, for a fragment that already holds the blocks. */
export function applyFragmentSideChannels(
  prepared: PreparedFragmentSeed,
  fragment: Y.XmlFragment
): void {
  if (!fragment.doc) return
  writeCriticMarkupMarksToYDoc(fragment.doc, prepared.marks)
  writeLinkReferencesToYDoc(fragment.doc, prepared.definitions, prepared.usages)
  applyWritingSeed(fragment, prepared.writingSentinels, prepared.writing)
}

async function seedFragment(
  markdown: string,
  fragment: Y.XmlFragment,
  notePath: string | undefined,
  options: { recordSource: boolean; writing?: WritingFrontmatter }
): Promise<boolean> {
  const prepared = await prepareFragmentSeed(markdown, notePath, options.writing)
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

/**
 * A whiteboard pointing at no canvas, which the vault gets no line for (see
 * `whiteboardDom` in server-specs.ts). Only a childless one: skipping a block
 * with children would drop them with it.
 */
function isEmptyWhiteboard(block: Block): boolean {
  if ((block.type as string) !== 'whiteboard' || block.children?.length) return false
  const props: object = block.props
  return !('canvasId' in props) || !props.canvasId
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
  const { blocks: spelled, languages } = hideBacktickLanguages(blocks)
  const { blocks: wrapped, replacements } = extractInlineColorRuns(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
    withPlainCheckboxMarkers(spelled as never[])
  )
  // The server editor exports the blocks before its first await, so the
  // export runs inside the token scope.
  const md = normalizeSerializedMarkdown(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
    await writeHtmlCommentTokens(wrapped as PartialBlock[], (b) => editor.blocksToMarkdownLossy(b))
  )
  return restoreInlineColorTokens(spellBacktickLanguages(md, languages), replacements)
}

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

    // A nested block loses the top-level walk's per-type dispatch, so anything
    // BlockNote's own serializer cannot express has to be re-claimed here. The
    // file marker is a DOM comment in the block spec, and a comment survives
    // only while BlockNote's HTML→markdown step passes raw HTML through — so a
    // file block under a list item is the one case the top-level fix does not
    // cover. Same bytes either way: the spec builds the comment from
    // `fileBlockCommentData`, which is what `serializeFileBlock` wraps.
    const shallowBlock = { ...block, children: [] } as Block
    const markdown =
      (block.type as string) === 'file'
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
          serializeFileBlock(block.props as FileBlockProps)
        : (block.type as string) === 'mathBlock'
          ? // Same reason as `file`: the `$` fence is three lines of ONE
            // paragraph in the spec's DOM, and a nested block that serializes
            // through BlockNote alone depends on its `<br>` handling to keep
            // them. Written from the shared serializer instead, so a nested
            // formula reaches the vault as the same bytes as a top-level one.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
            serializeMathBlock((block.props as { latex?: string }).latex ?? '')
          : (await serializeBlocks(editor, [shallowBlock] as PartialBlock[])).trim()
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const { open: isOpen, ...summaryProps } = block.props as { open?: boolean }
  // SAFETY: a paragraph carrying the toggle's own content and its props minus
  // `open`, which was destructured off above precisely because a paragraph's
  // propSchema has no such key.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- BlockNote Block generics do not model the Memry custom blocks this converter builds; the shape is fixed by packages/editor-schema; BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const summaryBlock = {
    ...block,
    type: 'paragraph',
    props: summaryProps,
    children: []
  } as unknown as PartialBlock
  const summary = (await serializeBlocks(editor, [summaryBlock])).trim()
  const children = (block.children ?? []) as Block[]
  const body = children.length > 0 ? await blocksToMarkdownPreserving(editor, children) : ''
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const colors = block.props as BlockColors
  const colorsMarker = hasNonDefaultColors(colors) ? serializeBlockColorsMarker(colors) : null

  return serializeToggleBlock(summary, body, colorsMarker, isOpen === true)
}

function isStructuredQuote(block: Block): boolean {
  return (block.type as string) === 'quote' && ((block.children ?? []) as Block[]).length > 0
}

function isCalloutWithChildren(block: Block): boolean {
  return (block.type as string) === 'callout' && ((block.children ?? []) as Block[]).length > 0
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
  // SAFETY: the quote's own inline content as a bare paragraph, so it is
  // serialized without the `> ` that `serializeQuoteOfBlocks` adds below.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- BlockNote Block generics do not model the Memry custom blocks this converter builds; the shape is fixed by packages/editor-schema; BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const own = { ...block, type: 'paragraph', props: {}, children: [] } as unknown as Block
  const children = (block.children ?? []) as Block[]
  const inner = await blocksToMarkdownPreserving(editor, [own, ...children])
  return serializeQuoteOfBlocks(inner.trim())
}

/**
 * A callout that owns children writes them inside its blockquote, after its
 * own line, the shape `resolveCalloutRun` reads back (#3186). BlockNote's own
 * serializer would put them after the callout. A callout without children
 * keeps the `calloutDom` path.
 */
async function serializeCalloutWithChildren(
  editor: ServerBlockNoteEditor,
  block: Block
): Promise<string> {
  // SAFETY: the callout's own inline content as a bare paragraph; `props` is
  // cleared because a paragraph's propSchema has no `type` key.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- BlockNote Block generics do not model the Memry custom blocks this converter builds; the shape is fixed by packages/editor-schema; BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const own = { ...block, type: 'paragraph', props: {}, children: [] } as unknown as Block
  const children = (block.children ?? []) as Block[]
  const inner = await blocksToMarkdownPreserving(editor, [own, ...children])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
  const props = block.props as { type: string; fold?: string }
  return serializeCalloutBlock(props.type, inner.trim(), props.fold)
}

/** Resolves Obsidian image embed refs against the open vault: ref to markdown link target. */
export type VaultEmbedResolver = (
  refs: string[],
  notePath?: string
) => Record<string, string> | Promise<Record<string, string>>

// Set by whoever loads this module: main's loader passes the direct vault
// lookup (blocknote-converter-loader.ts), the converter worker a call back to
// main (converter-worker.ts). Injected rather than imported because the
// lookup reads the index database, which the worker cannot open.
let vaultEmbedResolver: VaultEmbedResolver | null = null

export function setVaultEmbedResolver(resolver: VaultEmbedResolver): void {
  vaultEmbedResolver = resolver
}

/**
 * Main-process twin of the renderer's embed resolution: same rewrite, but the
 * vault lookup is a direct call instead of an IPC round trip. A closed vault or
 * an unreadable index resolves nothing, which leaves every embed as written.
 */
async function resolveWikiImageEmbedsInMarkdown(
  markdown: string,
  notePath?: string
): Promise<string> {
  const refs = extractWikiImageEmbedRefs(markdown)
  if (refs.length === 0) return markdown
  if (!vaultEmbedResolver) {
    log.warn('No vault embed resolver set, leaving embeds as written', { notePath })
    return markdown
  }

  try {
    const resolved = await vaultEmbedResolver(refs, notePath)
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
  const withEmbeds = await resolveWikiImageEmbedsInMarkdown(markdown, notePath)
  // The pipeline is the renderer's too (`parseMarkdownPreservingBlanks`): the
  // same bytes have to open as the same document in either process.
  return parseNoteMarkdown<Block>(
    {
      parse: (md) => parseMarkdownToBlocks(editor, md),
      serialize: (blocks) => serializeBlocks(editor, blocks),
      legacyBlocks: !readsLosslessBlocks(),
      legacyHtml: !readsLiteralHtml()
    },
    withEmbeds
  )
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
    const md = await serializeBlocks(editor, contentGroup)
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
    if (isEmptyWhiteboard(block)) {
      // Written as nothing at all, and skipped here rather than handed to the
      // content group: its spec DOM is an empty `<div>`, and leaving it in the
      // group would make the blank lines around it BlockNote's call instead of
      // the gap accounting's. The renderer's twin skips it the same way.
      continue
    }

    // SAFETY: as above — `MarkedBlock` is the `{ type, props }` subset.
    const markers = sidecarMarkerLines(block)

    if ((block.type as string) === 'taskBlock') {
      // BlockNote can't serialize a taskBlock (it's content:'none'), so emit the
      // `- [ ] … {task:id}` line ourselves. Subtasks at every depth follow on the
      // next lines (tight list) so a re-parse re-nests them under the parent.
      await flushContentGroup()
      flushGap()
      segments.push({ type: 'content', text: serializeTaskBlockTree(block).join('\n') })
    } else if ((block.type as string) === 'file') {
      // Emitted here rather than left to the block spec, which writes the marker
      // as a DOM comment node. That only reaches the vault because BlockNote's
      // HTML→markdown step passes comments through as raw HTML — an accident of
      // its `unified` pipeline, not a guarantee: the 0.51 serializer rewrite
      // returns "" for every node that is not an element or text, so the marker
      // (and with it the whole file block) would vanish on the next writeback.
      // Byte-identical to the renderer's twin in markdown-utils.ts, which has
      // always serialized the marker itself.
      await flushContentGroup()
      flushGap()
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
      segments.push({ type: 'content', text: serializeFileBlock(block.props as FileBlockProps) })
    } else if ((block.type as string) === 'mathBlock') {
      // Emitted here rather than left to the block spec for the same reason as
      // `file`: the spec's DOM is a paragraph whose `<br>`s BlockNote happens
      // to turn into newlines today, and the fence only works as three lines.
      // Byte-identical to the renderer's twin in markdown-utils.ts.
      await flushContentGroup()
      flushGap()
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
      const latex = (block.props as { latex?: string }).latex ?? ''
      const mathMd = serializeMathBlock(latex)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${mathMd}` : mathMd
      })
    } else if ((block.type as string) === 'toggleListItem') {
      await flushContentGroup()
      flushGap()
      segments.push({ type: 'content', text: await serializeToggle(editor, block) })
    } else if ((block.type as string) === 'columnList') {
      await flushContentGroup()
      flushGap()
      segments.push({
        type: 'content',
        text: await serializeColumnListBlock<Block>(block, (children) =>
          blocksToMarkdownPreserving(editor, children)
        )
      })
    } else if (isStructuredQuote(block) || isCalloutWithChildren(block)) {
      await flushContentGroup()
      flushGap()
      const quoted = isStructuredQuote(block)
        ? await serializeQuote(editor, block)
        : await serializeCalloutWithChildren(editor, block)
      segments.push({
        type: 'content',
        text: markers.length > 0 ? `${markers.join('\n')}\n${quoted}` : quoted
      })
    } else if (isEmptyParagraph(block)) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup)
        segments.push({ type: 'content', text: md.trim() })
        contentGroup = []
      }
      emptyCount++
    } else if (markers.length > 0) {
      if (contentGroup.length > 0) {
        const md = await serializeBlocks(editor, contentGroup)
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
        const md = await serializeBlocks(editor, contentGroup)
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
    const md = await serializeBlocks(editor, contentGroup)
    // Trim the trailing newline BlockNote appends to list/heading groups; left
    // untrimmed it re-parses as a growing blank-line gap on every writeback.
    segments.push({ type: 'content', text: md.trim() })
  }
  // The host editor keeps an empty paragraph after a trailing portal so the
  // caret has somewhere to go (portal-trailing-paragraph-plugin). It is not
  // content: a file ending in the fence stays byte-identical on every save.
  const lastBlock = blocks.findLast((block) => !isEmptyParagraph(block))
  const endsInPortal =
    lastBlock !== undefined &&
    (lastBlock.type as string) === 'codeBlock' &&
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- BlockNote Block/PartialBlock generics do not model the Memry custom blocks and props; the shape is fixed by packages/editor-schema
    (lastBlock.props as { language?: string }).language === PORTAL_BLOCK_LANGUAGE
  if (emptyCount > 0 && !endsInPortal) {
    segments.push({ type: 'gap', extraLines: emptyCount })
  }

  return assembleMarkdownWithBlanks(segments)
}
