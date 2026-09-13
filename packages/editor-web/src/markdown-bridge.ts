import { splitFrontmatterBlock } from '@memry/shared/frontmatter-split'
import type { MarkdownExportResult, MarkdownSeedResult } from '@memry/contracts/webview-bridge'

/**
 * The markdown conversion PAIR, in the editor bundle (T124, chapter 12 §12.1).
 *
 * This is the one place in the product that turns markdown into a document or a
 * document into markdown on the phone path. BlockNote and `@memry/editor-schema`
 * are the implementation; the Rust core owns `extract_text` and nothing else
 * (§12.1.2), and it never sees a `---` fence — the frontmatter split happens
 * here too, on bytes the core carried verbatim.
 *
 * Two inbound entry points, deliberately, because they answer to two different
 * hosts:
 *
 * - `seedFromMarkdown` serves the `seed-from-markdown` message. Its input is a
 *   note record's create-time `content`, so it splits frontmatter off first.
 * - `seedFromDocLoad` serves `doc-load.seedMarkdown`, which every shipped host
 *   uses and which §12.1.1 documents as parsing its input VERBATIM, no
 *   frontmatter split. Its behaviour is frozen: an older host must keep getting
 *   exactly what it gets today.
 *
 * Neither ever reads the frontmatter it splits off. A new note's tags and
 * properties come from the note record — the core has already written them
 * (`crates/memry-core/src/domain/notes.rs`, `templates.rs`) — and a guest that
 * re-derived them from the YAML would be a second source of truth for the same
 * note.
 */

/**
 * The slice of BlockNote both directions need.
 *
 * Narrow on purpose: the conversion is four editor calls and no DOM, so stating
 * it as an interface is what lets it be tested without standing up a WebView —
 * and what keeps the rules below readable next to the BlockNote generics the
 * custom schema makes unwriteable by hand.
 *
 * Blocks are `unknown` because this module never interprets one. It parses,
 * hands the result straight back to `replaceBlocks`, and looks at exactly one
 * field (`content`, to decide whether the document is empty). Naming the block
 * type here would also be wrong rather than merely verbose: BlockNote's
 * `replaceBlocks` takes block IDENTIFIERS on the left and partial blocks on the
 * right, so one type parameter cannot describe both ends of a whole-document
 * replace.
 */
export interface MarkdownEditorSurface {
  readonly document: unknown[]
  /** Defaults to the whole document, which is the only thing exported here. */
  blocksToMarkdownLossy(): string
  tryParseMarkdownToBlocks(markdown: string): unknown[]
  replaceBlocks(target: unknown[], blocks: unknown[]): void
}

/** The mounted document, re-serialized through the schema. */
export function exportMarkdown(editor: MarkdownEditorSurface): MarkdownExportResult {
  try {
    return { status: 'ok', markdown: editor.blocksToMarkdownLossy() }
  } catch (error) {
    return { status: 'error', detail: describe(error) }
  }
}

/**
 * Seed a document from a note record's create-time `content`.
 *
 * The payload arrives byte for byte as the core stored it, frontmatter and all,
 * so the block is sliced off with the shared splitter — the same function
 * `@memry/app-core` uses, so the two can never disagree about where a body
 * starts — and only the body is parsed.
 */
export function seedFromMarkdown(
  editor: MarkdownEditorSurface,
  content: string
): MarkdownSeedResult {
  return seed(editor, splitFrontmatterBlock(content).body)
}

/**
 * Seed a document from `doc-load.seedMarkdown`.
 *
 * Parses its input verbatim, frontmatter included, because that is what it has
 * always done (§12.1.1) and every host in the field depends on it. Changing it
 * here would change what an existing build produces for an existing note.
 */
export function seedFromDocLoad(
  editor: MarkdownEditorSurface,
  seedMarkdown: string
): MarkdownSeedResult {
  return seed(editor, seedMarkdown)
}

/**
 * Parse and apply, with the two guards that make seeding safe.
 *
 * The empty-document guard is the one that matters: seeding is a whole-document
 * replace, so applying it to a document that already has content would delete a
 * real body on every device the note reaches.
 *
 * A parse failure returns `error` and leaves the document ALONE. It must never
 * read as an empty document — the host still holds the only copy of what the
 * user asked for and clears it on a successful seed, so a silent empty here
 * would destroy the content and look like the reader's own doing.
 */
function seed(editor: MarkdownEditorSurface, markdown: string): MarkdownSeedResult {
  if (markdown.trim().length === 0) return { status: 'skipped', reason: 'no-body' }
  if (!isEditorEmpty(editor)) return { status: 'skipped', reason: 'not-empty' }

  let blocks: unknown[]
  try {
    blocks = editor.tryParseMarkdownToBlocks(markdown)
  } catch (error) {
    return { status: 'error', detail: describe(error) }
  }
  // Non-empty markdown that parses to nothing is not a failure the host can act
  // on — there is no content to lose and nothing to retry — so it is reported
  // as the same spent seed a blank payload is.
  if (blocks.length === 0) return { status: 'skipped', reason: 'no-body' }

  try {
    editor.replaceBlocks(editor.document, blocks)
  } catch (error) {
    return { status: 'error', detail: describe(error) }
  }
  return { status: 'seeded' }
}

/**
 * Whether the document holds nothing but its trailing empty paragraph.
 *
 * BlockNote always keeps one block, so "no blocks" is never the answer; an
 * empty doc is a single block with no content.
 */
function isEditorEmpty(editor: MarkdownEditorSurface): boolean {
  const blocks = editor.document
  if (blocks.length > 1) return false
  const only = blocks[0]
  if (!only) return true
  const content = (only as { content?: unknown }).content
  return !Array.isArray(content) || content.length === 0
}

/** A detail string a host can show; `min(1)` on the wire, so never empty. */
function describe(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.length > 0 ? detail : 'markdown conversion failed'
}
