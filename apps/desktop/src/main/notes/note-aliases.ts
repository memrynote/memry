import type { NoteAliasEdit, NoteAliasEditResponse } from '@memry/contracts/notes-api'
import { isDeepStrictEqual } from 'util'
import { extractDateFromPath } from '@main/database/queries/notes'
import { getNoteById, updateNote } from '../vault/notes'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { enqueueJournalUpdate } from '../journal/runtime-effects'
import { syncNoteUpdate } from './runtime-effects'

export async function editNoteAliasesCommand(input: NoteAliasEdit): Promise<NoteAliasEditResponse> {
  const before = await getNoteById(input.id)
  if (!before) throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  const { note } = await updateNote({
    id: input.id,
    aliases: { add: input.add, remove: input.remove }
  })
  if (!isDeepStrictEqual(before.aliases, note.aliases)) {
    const date = extractDateFromPath(note.path)
    if (date === null) syncNoteUpdate(note.id)
    else enqueueJournalUpdate(note.id, date)
  }
  return { aliases: note.aliases }
}
