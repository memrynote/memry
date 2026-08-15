import {
  createNote,
  updateNote,
  renameNote,
  moveNote,
  deleteNote,
  getNoteById,
  type Note,
  type NoteCreateInput,
  type NoteUpdateInput
} from '../vault/notes'
import { extractTags } from '../vault/frontmatter'
import { NoteError, NoteErrorCode } from '../lib/errors'
import {
  syncNoteCreate,
  syncNoteUpdate,
  syncNoteDelete,
  setNoteLocalOnlyState,
  cleanupProjectLinksForDeletedNote
} from './runtime-effects'

export async function createNoteCommand(input: NoteCreateInput): Promise<Note> {
  const note = await createNote(input)
  // Frontmatter tags only. `note.tags` merges the body's `#hashtag`s in for the
  // index, and the CRDT tag array they would land in is what write-back writes
  // back into the file's `tags:` block (#1454).
  syncNoteCreate(note.id, note.title, extractTags(note.frontmatter))
  return note
}

export async function updateNoteCommand(input: NoteUpdateInput): Promise<Note> {
  const note = await updateNote(input)
  const hasMetadataChanges =
    input.title !== undefined ||
    input.tags !== undefined ||
    input.frontmatter !== undefined ||
    input.emoji !== undefined

  if (hasMetadataChanges) {
    syncNoteUpdate(input.id, input.title)
  }

  return note
}

export async function renameNoteCommand(id: string, newTitle: string): Promise<Note> {
  const note = await renameNote(id, newTitle)
  syncNoteUpdate(id, newTitle)
  return note
}

export async function moveNoteCommand(id: string, newFolder: string): Promise<Note> {
  const note = await moveNote(id, newFolder)
  syncNoteUpdate(id)
  return note
}

export async function deleteNoteCommand(id: string): Promise<void> {
  // Enqueue sync delete BEFORE cache removal — enqueue reads cache for vector clock
  syncNoteDelete(id)
  await deleteNote(id)
  // Drop the note's project links + clear any project home note pointing at it,
  // only once the note is actually gone (spec §4 "Cleanup rules").
  await cleanupProjectLinksForDeletedNote(id)
}

export async function setNoteLocalOnlyCommand(input: {
  id: string
  localOnly: boolean
}): Promise<Note> {
  // localOnly is sidecar-only state — never written to the file
  setNoteLocalOnlyState(input.id, input.localOnly)
  const note = await getNoteById(input.id)
  if (!note) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }
  return note
}
