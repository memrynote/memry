import {
  createNote,
  updateNote,
  renameNote,
  moveNote,
  deleteNote,
  type Note,
  type NoteCreateInput,
  type NoteUpdateInput
} from '../vault/notes'
import {
  syncNoteCreate,
  syncNoteUpdate,
  syncNoteDelete,
  setNoteLocalOnlyState
} from './runtime-effects'

export async function createNoteCommand(input: NoteCreateInput): Promise<Note> {
  const note = await createNote(input)
  syncNoteCreate(note.id, note.title, note.tags)
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
}

export async function setNoteLocalOnlyCommand(input: {
  id: string
  localOnly: boolean
}): Promise<Note> {
  const note = await updateNote({
    id: input.id,
    frontmatter: { localOnly: input.localOnly }
  })
  setNoteLocalOnlyState(input.id, input.localOnly)
  return note
}
