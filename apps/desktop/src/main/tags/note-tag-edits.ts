import { inArray } from 'drizzle-orm'
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import type { getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { tagOrUnder } from '@main/database/queries/tag-match'
import { createLogger } from '../lib/logger'
import { updateNoteCommand } from '../notes/domain'
import { hasAnyVaultLock, isNoteLocked } from '../vault-locks/registry'

const log = createLogger('NoteTagEdits')

type IndexDb = ReturnType<typeof getIndexDatabase>

export function keepLockedNoteTags(indexDb: IndexDb, tag: string): () => void {
  if (!hasAnyVaultLock()) return () => {}
  const lockedIds = indexDb
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(tagOrUnder(noteTags.tag, tag.trim()))
    .all()
    .map((row) => row.noteId)
    .filter((noteId) => isNoteLocked(noteId))
  if (lockedIds.length === 0) return () => {}
  const kept = indexDb.select().from(noteTags).where(inArray(noteTags.noteId, lockedIds)).all()
  return () => {
    indexDb.delete(noteTags).where(inArray(noteTags.noteId, lockedIds)).run()
    indexDb.insert(noteTags).values(kept).run()
  }
}

export function writableTagCarrier(indexDb: IndexDb, noteId: string): boolean {
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached || cached.fileType !== 'markdown') return false
  if (isNoteLocked(noteId, cached.path)) {
    log.info('Left the tags of a locked note unchanged', { noteId })
    return false
  }
  return true
}

export async function editNoteHeaderTags(
  indexDb: IndexDb,
  noteId: string,
  headerTags: HeaderTagEdit
): Promise<void> {
  if (!writableTagCarrier(indexDb, noteId)) return
  await updateNoteCommand({ id: noteId, headerTags })
}
