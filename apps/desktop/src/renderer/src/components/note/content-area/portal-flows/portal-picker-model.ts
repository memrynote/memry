/**
 * The portal picker's rows: blocks, then notes, then "Create note". Pure, so the merge,
 * the caps and the cycle filter are testable without an editor.
 *
 * @module note/content-area/portal-flows/portal-picker-model
 */

import { stripAnchor } from '@memry/shared/portal-block'
import { findPortalCycle } from './portal-insert'
import { PORTAL_PICKER_TRIGGER } from './portal-slash-items'

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
  /** The enclosing block's text, shown as `Note › Parent`. */
  parentText?: string | null
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
      parentText: string | null
      blockId: string
      anchor: string | null
      title: string
      /** The typed query, for bolding its match in the row. */
      query: string
    }
  /** Always last, only for a non-empty query: creates a note titled `title`. */
  | { kind: 'create'; key: 'create'; title: string }

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
  query?: string
  /** The block holding the caret, i.e. the line the `((` query is typed in. */
  activeBlockId?: string
}): PortalPickerItem[] {
  // A note cannot show itself, so the host and its portal ancestors are not
  // offered whole. One of the host's own blocks is fine: a loop only forms if
  // the portal sits inside that block, and rendering stops it there.
  const noteAllowed = (noteId: string): boolean =>
    findPortalCycle(input.hostNoteId, input.ancestry, noteId) === null
  // The block search reads the host's live doc, so it also returns the line being typed
  // (and stale half-typed `((...` lines); picking one would make a portal to itself.
  const blockAllowed = (block: PortalPickerBlock): boolean => {
    if (findPortalCycle(input.hostNoteId, input.ancestry, block.noteId) === 'ancestor') return false
    if (block.noteId !== input.hostNoteId) return true
    return block.blockId !== input.activeBlockId && !block.text.includes(PORTAL_PICKER_TRIGGER)
  }

  const noteItems: PortalPickerItem[] = []
  for (const note of input.notes) {
    if (noteItems.length >= PICKER_NOTE_LIMIT) break
    if (!noteAllowed(note.noteId)) continue
    noteItems.push({
      kind: 'note',
      key: `note:${note.noteId}`,
      noteId: note.noteId,
      title: note.title,
      folder: folderLabel(note.path),
      emoji: note.emoji ?? null
    })
  }

  const blockItems: PortalPickerItem[] = []
  let blockCount = 0
  for (const block of input.blocks) {
    if (blockCount >= PICKER_BLOCK_LIMIT) break
    if (!blockAllowed(block)) continue
    blockCount += 1
    blockItems.push({
      kind: 'block',
      key: `block:${block.noteId}:${block.blockId}`,
      noteId: block.noteId,
      noteTitle: block.noteTitle,
      parentText: block.parentText ?? null,
      blockId: block.blockId,
      anchor: block.anchor,
      title: stripAnchor(block.text),
      query: input.query?.trim() ?? ''
    })
  }

  const items = [...blockItems, ...noteItems]
  const query = input.query?.trim() ?? ''
  if (query !== '') items.push({ kind: 'create', key: 'create', title: query })
  return items
}
