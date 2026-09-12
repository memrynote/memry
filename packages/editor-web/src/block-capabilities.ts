/**
 * What the block actions menu may offer for ONE block (#2100).
 *
 * Pure: nothing here touches the DOM, the bridge or a live editor. The hide
 * rules are read off the SCHEMA rather than a hand-copied table, so a spec
 * change in `@memry/editor-schema` moves this menu and desktop's
 * `BlockColorsItem` at the same time instead of leaving mobile behind.
 *
 * Mirrors `apps/desktop/src/renderer/src/components/note/content-area/block-side-menu.tsx`,
 * which is the surface this one is the phone's answer to.
 */

import type { BlockColour } from '@memry/contracts/webview-bridge'

/** The narrow slice of a block these helpers read. A real `Block` satisfies it. */
export interface BlockLikeForCaps {
  type: string
  props: object
  content: unknown
  children?: readonly unknown[]
}

/** The narrow slice of `editor.schema`. A real BlockNoteEditor satisfies it. */
export interface SchemaLikeForCaps {
  blockSchema: Record<string, { propSchema: Record<string, unknown> }>
}

/** What the menu may offer for ONE block. Every field is derived, never stored. */
export interface BlockCapabilities {
  /** `textColor` is in the block's own propSchema. */
  colourText: boolean
  /** `backgroundColor` is in the block's own propSchema. */
  colourBackground: boolean
  /** False on attachment blocks: the bytes live under the SOURCE note's id. */
  canMove: boolean
  /** Duplicate/Move/Delete carry the subtree; the panel says so when true. */
  hasChildren: boolean
  /** A word, not the toolbar's lossy glyph. "Heading 2", "Image", "Table". */
  label: string
}

/**
 * The panel's whole state, frozen when it opens.
 *
 * Carried IN the `ToolbarView`, so the single-block rule is the view's payload
 * rather than a convention: a selection change while the panel is open cannot
 * substitute a different block, because there is no code path that reads the
 * caret again.
 */
export interface BlockActionTarget {
  blockId: string
  caps: BlockCapabilities
  textColour: BlockColour
  backgroundColour: BlockColour
}

export type BlockAction =
  | { kind: 'colour'; slot: 'text' | 'background'; colour: BlockColour }
  | { kind: 'duplicate' }
  | { kind: 'move' }
  | { kind: 'delete' }

/**
 * Blocks that own an attachment, block-level or inline.
 *
 * Desktop's `ATTACHMENT_BLOCK_TYPES`. "Move to" is hidden on these: the bytes
 * live under `attachments/<owning note id>/` and the target note's
 * `attachmentReferences` row never gains the id, so the embed would resolve on
 * this device and be broken on every other one.
 */
const ATTACHMENT_BLOCK_TYPES: ReadonlySet<string> = new Set(['file', 'image', 'video', 'audio'])

/**
 * Blocks a long-press may address.
 *
 * A hand-listed set, not a schema query, because the reason is iOS's rather
 * than the schema's: the loupe owns long-press on editable text, and a
 * competing timer there produces a selection the reader did not ask for.
 *
 * Desktop's `NON_TEXT_BLOCK_TYPES` minus `table`, whose CELLS are editable
 * text, plus `divider`, which desktop reaches through a hover handle the phone
 * does not have and which carries no text of its own to compete for.
 */
export const LONG_PRESS_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'file',
  'image',
  'video',
  'audio',
  'youtubeEmbed',
  'bookmark',
  'taskBlock',
  'divider'
])

/**
 * Sheet titles.
 *
 * Deliberately NOT the toolbar's `blockLabel` glyph, which is one or two
 * characters sized for a chip. Two labels for two jobs is not duplication.
 */
export const BLOCK_LABELS: Readonly<Record<string, string>> = {
  paragraph: 'Paragraph',
  heading: 'Heading',
  bulletListItem: 'Bulleted list',
  numberedListItem: 'Numbered list',
  checkListItem: 'To-do list',
  toggleListItem: 'Toggle list',
  quote: 'Quote',
  codeBlock: 'Code',
  callout: 'Callout',
  divider: 'Divider',
  table: 'Table',
  image: 'Image',
  file: 'File',
  video: 'Video',
  audio: 'Audio',
  bookmark: 'Bookmark',
  youtubeEmbed: 'YouTube embed',
  taskBlock: 'Task'
}

/** Block-level attachment, or an `inlineImage` in its content. Desktop's rule. */
export function carriesAttachment(block: BlockLikeForCaps): boolean {
  if (ATTACHMENT_BLOCK_TYPES.has(block.type)) return true
  const content = block.content
  if (!Array.isArray(content)) return false
  return content.some(
    (node) =>
      typeof node === 'object' &&
      node !== null &&
      (node as { type?: unknown }).type === 'inlineImage'
  )
}

/** "Heading 2" rather than "Heading": the level is what tells two apart. */
function labelFor(block: BlockLikeForCaps): string {
  const base = BLOCK_LABELS[block.type]
  if (base === undefined) return 'Block'
  const level = (block.props as { level?: unknown }).level
  if (block.type === 'heading' && typeof level === 'number') return `${base} ${level}`
  return base
}

export function blockCapabilities(
  block: BlockLikeForCaps,
  schema: SchemaLikeForCaps
): BlockCapabilities {
  const propSchema = schema.blockSchema[block.type]?.propSchema ?? {}
  return {
    colourText: 'textColor' in propSchema,
    colourBackground: 'backgroundColor' in propSchema,
    // The one rule that is NOT schema-derived: "this block owns bytes under the
    // source note's id" is a fact about the vault, not about the node.
    canMove: !carriesAttachment(block),
    hasChildren: Array.isArray(block.children) && block.children.length > 0,
    label: labelFor(block)
  }
}
