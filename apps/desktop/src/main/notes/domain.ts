import {
  createNote,
  updateNote,
  renameNote,
  moveNote,
  renameFolder,
  deleteNote,
  getNoteById,
  type Note,
  type NoteCreateInput,
  type NoteUpdateInput
} from '../vault/notes'
import { extractTags } from '../vault/frontmatter'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { createLogger } from '../lib/logger'
import { getIndexDatabase } from '../database'
import { extractDateFromPath, getNoteCacheById } from '@main/database/queries/notes'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { assertNoteWritable } from '../vault-locks/registry'
import {
  syncNoteCreate,
  syncNoteUpdate,
  syncNoteDelete,
  setNoteLocalOnlyState,
  cleanupProjectLinksForDeletedNote,
  unlinkTasksFromDeletedNote,
  queueEmbeddedVaultFiles
} from './runtime-effects'

const log = createLogger('NotesDomain')

export async function createNoteCommand(input: NoteCreateInput): Promise<Note> {
  const note = await createNote(input)
  // Frontmatter tags only. `note.tags` merges the body's `#hashtag`s in for the
  // index, and the CRDT tag array they would land in is what write-back writes
  // back into the file's `tags:` block (#1454).
  syncNoteCreate(note.id, note.title, extractTags(note.frontmatter))
  queueEmbeddedVaultFiles(note.id, note.content)
  return note
}

export async function updateNoteCommand(input: NoteUpdateInput): Promise<Note> {
  const note = await updateNote(input)
  // `updateNote` moves the index hash to the new bytes, so the watcher never
  // feeds this edit, and the next write-back would put the doc's older body
  // back over it (#2646). No `writing`: the doc keeps its own alternatives.
  // The file is already written, so a failed feed must not fail the save.
  if (input.content !== undefined) {
    try {
      await feedExternalEditToCrdt(input.id, input.content)
    } catch (err) {
      log.error('Could not feed the saved body to the note CRDT doc', { noteId: input.id, err })
    }
    queueEmbeddedVaultFiles(input.id, input.content)
  }
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

/**
 * A rename or move that turns a journal into a note or back is handed to the
 * watcher (see `changesJournalDate` in notes-rename), which deletes the old item
 * and creates the new one. Pushing a note update for the old id on top would
 * send a journal's id as a note.
 */
function journalDateOf(id: string): string | null {
  return getNoteCacheById(getIndexDatabase(), id)?.date ?? null
}

export async function renameNoteCommand(id: string, newTitle: string): Promise<Note> {
  const before = journalDateOf(id)
  const note = await renameNote(id, newTitle)
  if (before === null && extractDateFromPath(note.path) === null) syncNoteUpdate(id, newTitle)
  return note
}

export async function moveNoteCommand(id: string, newFolder: string): Promise<Note> {
  const before = journalDateOf(id)
  const note = await moveNote(id, newFolder)
  if (before === null && extractDateFromPath(note.path) === null) syncNoteUpdate(id)
  return note
}

/**
 * A folder rename or move carries the index rows of everything inside it, so
 * each moved note's new path is pushed the way `moveNoteCommand` pushes one.
 * Journals are skipped: their path is derived from the date on every device.
 */
export async function renameFolderCommand(oldPath: string, newPath: string): Promise<void> {
  const movedNotes = await renameFolder(oldPath, newPath)
  for (const note of movedNotes) {
    if (note.date === null) syncNoteUpdate(note.id)
  }
}

export async function deleteNoteCommand(id: string): Promise<void> {
  // Before the sync delete is queued: a refused delete must not reach peers.
  assertNoteWritable(id)
  // Enqueue sync delete BEFORE cache removal — enqueue reads cache for vector clock
  syncNoteDelete(id)
  await deleteNote(id)
  // Drop the note's project links + clear any project home note pointing at it,
  // only once the note is actually gone (spec §4 "Cleanup rules").
  await cleanupProjectLinksForDeletedNote(id)
  await unlinkTasksFromDeletedNote(id)
}

export async function setNoteLocalOnlyCommand(input: {
  id: string
  localOnly: boolean
}): Promise<Note> {
  // A sync-policy change of a locked note is a local edit too (#2606).
  assertNoteWritable(input.id)
  // localOnly is sidecar-only state — never written to the file
  setNoteLocalOnlyState(input.id, input.localOnly)
  const note = await getNoteById(input.id)
  if (!note) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }
  return note
}
