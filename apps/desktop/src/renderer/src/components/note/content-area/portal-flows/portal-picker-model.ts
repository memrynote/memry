/**
 * The portal picker's rows: notes and blocks in one list. Pure, so the merge,
 * the caps and the cycle filter are testable without an editor.
 *
 * @module note/content-area/portal-flows/portal-picker-model
 */

import { stripAnchor } from '@memry/shared/portal-block'
import { findPortalCycle } from './portal-insert'

export const PICKER_NOTE_LIMIT = 30
export const PICKER_BLOCK_LIMIT = 8

export interface PortalPickerNote {
  noteId: string
  title: string
  path: string
  emoji?: string | null
}

export interface PortalPickerBlock {
  noteId: string
  noteTitle: string
  blockId: string
  /** Set when the source block already carries ` ^anchor`. */
  anchor: string | null
  text: string
}

export type PortalPickerItem =
  | {
      kind: 'note'
      key: string
      noteId: string
      title: string
      folder: string
      emoji: string | null
    }
  | {
      kind: 'block'
      key: string
      noteId: string
      noteTitle: string
      blockId: string
      anchor: string | null
      title: string
    }

/** `Lectures/Biology/Cell Biology.md` -> `Lectures / Biology`. */
export function folderLabel(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join(' / ')
}

export function buildPortalPickerList(input: {
  notes: readonly PortalPickerNote[]
  blocks: readonly PortalPickerBlock[]
  hostNoteId: string | undefined
  ancestry: readonly string[]
}): PortalPickerItem[] {
  // A note cannot show itself, so the host and its portal ancestors are not
  // offered whole. One of the host's own blocks is fine: a loop only forms if
  // the portal sits inside that block, and rendering stops it there.
  const noteAllowed = (noteId: string): boolean =>
    findPortalCycle(input.hostNoteId, input.ancestry, noteId) === null
  const blockAllowed = (noteId: string): boolean =>
    findPortalCycle(input.hostNoteId, input.ancestry, noteId) !== 'ancestor'

  const items: PortalPickerItem[] = []
  for (const note of input.notes) {
    if (items.length >= PICKER_NOTE_LIMIT) break
    if (!noteAllowed(note.noteId)) continue
    items.push({
      kind: 'note',
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      title: note.title,
      folder: folderLabel(note.path),
      emoji: note.emoji ?? null
    })
  }

  let blockCount = 0
  for (const block of input.blocks) {
    if (blockCount >= PICKER_BLOCK_LIMIT) break
    if (!blockAllowed(block.noteId)) continue
    blockCount += 1
    items.push({
      kind: 'block',
      key: `block:${block.noteId}:${block.blockId}`,
      noteId: block.noteId,
      noteTitle: block.noteTitle,
      blockId: block.blockId,
      anchor: block.anchor,
      title: stripAnchor(block.text)
    })
  }

  return items
}
