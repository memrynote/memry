/**
 * Building and inserting a `memry-portal` fence. The host note stores only the
 * definition JSON in an ordinary `codeBlock` with `language: "memry-portal"`
 * (`@memry/shared/portal-block`); the portal block renderer draws the window.
 *
 * @module note/content-area/portal-flows/portal-insert
 */

import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import {
  PORTAL_BLOCK_LANGUAGE,
  serializePortalDefinition,
  type PortalDefinition
} from '@memry/shared/portal-block'
import type { EditorSchema } from '../editor-schema'

export type PortalCycle = 'self' | 'ancestor'

/**
 * Whether a portal to `sourceNoteId` placed in `hostNoteId` would show the host
 * inside itself. `ancestry` is the chain of notes whose portals this editor is
 * nested in, outermost first. Render guards the same cycles; refusing at insert
 * time keeps the loop from ever being written to a note.
 */
export function findPortalCycle(
  hostNoteId: string | undefined,
  ancestry: readonly string[],
  sourceNoteId: string
): PortalCycle | null {
  if (sourceNoteId === hostNoteId) return 'self'
  return ancestry.includes(sourceNoteId) ? 'ancestor' : null
}

export function noteDefinition(noteId: string): PortalDefinition {
  return { v: 1, target: { kind: 'note', note: noteId }, raw: {} }
}

/** A block portal is inserted collapsed: one root, no `open` entries. */
export function blockDefinition(noteId: string, anchor: string): PortalDefinition {
  return { v: 1, target: { kind: 'blocks', note: noteId, blocks: [anchor], open: {} }, raw: {} }
}

/** The fence as it sits in a markdown file, for the clipboard. */
export function portalFenceMarkdown(definition: PortalDefinition): string {
  return `\`\`\`${PORTAL_BLOCK_LANGUAGE}\n${serializePortalDefinition(definition)}\n\`\`\``
}

/**
 * Insert a portal block at the caret and move the caret past it: left inside,
 * the next keystroke would land in the definition's JSON, not in the note.
 * Returns the inserted block id.
 */
export function insertPortalBlock(
  editor: EditorSchema['BlockNoteEditor'],
  definition: PortalDefinition
): string {
  const inserted = insertOrUpdateBlockForSlashMenu(editor, {
    type: 'codeBlock',
    props: { language: PORTAL_BLOCK_LANGUAGE },
    content: serializePortalDefinition(definition)
  })
  const next = editor.getNextBlock(inserted.id)
  const nextIsEmptyParagraph =
    next?.type === 'paragraph' && Array.isArray(next.content) && next.content.length === 0
  const target =
    next && nextIsEmptyParagraph
      ? next
      : editor.insertBlocks([{ type: 'paragraph' }], inserted.id, 'after')[0]
  editor.setTextCursorPosition(target, 'start')
  return inserted.id
}
