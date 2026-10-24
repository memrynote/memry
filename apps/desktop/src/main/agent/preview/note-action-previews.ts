import type { ChangePreview, ChangePreviewField } from '@memry/contracts/ipc-agent'

import type { VaultServiceHandles } from '../mcp/tools/handles'
import { NOTE_ACTION_TOOL_SCHEMAS } from '../mcp/tools/note-action-schemas'
import type { Builder } from './build-change-preview'
import { field, fields } from './format'

type NoteIndex = { notes: Pick<VaultServiceHandles['notes'], 'stored'> }

/** How many titles the card header names before it says "+N more". */
const TITLES_SHOWN = 3

/**
 * The index row for a note, or null. A preview must still draw when a note
 * vanished since the agent listed it, so a failed read is "unknown", not fatal.
 */
async function storedNote(id: string, handles: NoteIndex) {
  try {
    return await handles.notes.stored(id)
  } catch {
    return null
  }
}

async function noteTitles(ids: string[], handles: NoteIndex): Promise<string[]> {
  return Promise.all(ids.map(async (id) => (await storedNote(id, handles))?.title ?? id))
}

/** One card for the whole batch: the first few titles, then a count. */
function batchPreview(
  titles: string[],
  intent: ChangePreview['intent'],
  rows: (ChangePreviewField | null)[]
): ChangePreview {
  const shown = titles.slice(0, TITLES_SHOWN).join(', ')
  const rest = titles.length - TITLES_SHOWN
  return {
    kind: 'fields',
    item: { type: 'note', id: null, title: rest > 0 ? `${shown} +${rest}` : shown, context: null },
    intent,
    fields: fields(field('notes', null, titles.length), ...rows),
    body: null,
    loss: [],
    destructive: false
  }
}

const bulkTag = async (
  args: Parameters<Builder>[0],
  handles: NoteIndex
): Promise<ChangePreview> => {
  const { ids, add, remove } = NOTE_ACTION_TOOL_SCHEMAS.vault_bulk_tag_notes.input.parse(args)
  return batchPreview(await noteTitles(ids, handles), 'update', [
    field('add', null, add),
    field('remove', null, remove)
  ])
}

const bulkMove = async (
  args: Parameters<Builder>[0],
  handles: NoteIndex
): Promise<ChangePreview> => {
  const { ids, folder_path } = NOTE_ACTION_TOOL_SCHEMAS.vault_bulk_move_notes.input.parse(args)
  const folders = new Set(
    await Promise.all(ids.map(async (id) => (await storedNote(id, handles))?.folder_path ?? null))
  )
  // A single shared source folder reads as a real "before"; mixed folders do not.
  const before = folders.size === 1 ? [...folders][0] : null
  return batchPreview(await noteTitles(ids, handles), 'move', [
    field('folder', before, folder_path)
  ])
}

const copyNotes = async (
  args: Parameters<Builder>[0],
  handles: NoteIndex
): Promise<ChangePreview> => {
  const { ids, folder_path } = NOTE_ACTION_TOOL_SCHEMAS.vault_copy_notes.input.parse(args)
  return batchPreview(await noteTitles(ids, handles), 'create', [
    field('folder', null, folder_path)
  ])
}

const insertAtCursor = async (
  args: Parameters<Builder>[0],
  handles: NoteIndex
): Promise<ChangePreview> => {
  const { id, items } = NOTE_ACTION_TOOL_SCHEMAS.vault_insert_at_cursor.input.parse(args)
  const parts = await Promise.all(
    items.map(async (item) =>
      item.type === 'text'
        ? item.text
        : `[[${(await storedNote(item.note_id, handles))?.title ?? item.note_id}]]`
    )
  )
  const target = (await storedNote(id, handles))?.title ?? id
  return {
    kind: 'fields',
    item: { type: 'note', id, title: target, context: null },
    intent: 'update',
    fields: fields(field('insert', null, parts.join(' '))),
    body: null,
    loss: [],
    destructive: false
  }
}

export const NOTE_ACTION_PREVIEW_BUILDERS = {
  vault_bulk_tag_notes: bulkTag,
  vault_bulk_move_notes: bulkMove,
  vault_copy_notes: copyNotes,
  vault_insert_at_cursor: insertAtCursor
} satisfies Record<
  string,
  (args: Parameters<Builder>[0], handles: NoteIndex) => Promise<ChangePreview>
>
