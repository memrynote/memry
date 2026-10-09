import { eq, inArray, like, or } from 'drizzle-orm'
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import type { getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'
import { updateNoteCommand } from '../notes/domain'
import { hasAnyVaultLock, isNoteLocked } from '../vault-locks/registry'

const log = createLogger('NoteTagEdits')

type IndexDb = ReturnType<typeof getIndexDatabase>

/**
 * Snapshot the index tag rows of every locked note that carries `tag` (or a
 * child of it) before a vault-wide rename, merge or delete, and put them back
 * verbatim after it. The file of a locked note is left as it is, so its index
 * rows must not change either (#2606).
 */
export function keepLockedNoteTags(indexDb: IndexDb, tag: string): () => void {
  if (!hasAnyVaultLock()) return () => {}
  const normalized = tag.toLowerCase().trim()
  const lockedIds = indexDb
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(or(eq(noteTags.tag, normalized), like(noteTags.tag, `${normalized}/%`)))
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

/**
 * The markdown note `noteId` when a vault-wide tag edit may write it: a locked
 * note keeps its file, and a filed binary has no frontmatter, so for either the
 * index rows the caller already rewrote are its tags.
 */
export function writableTagCarrier(indexDb: IndexDb, noteId: string): boolean {
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached || cached.fileType !== 'markdown') return false
  if (isNoteLocked(noteId, cached.path)) {
    log.info('Left the tags of a locked note unchanged', { noteId })
    return false
  }
  return true
}

/**
 * One note's part of a vault-wide tag merge or delete. The header edit goes
 * through the note command, so an open editor's doc follows it instead of
 * writing the old list back.
 */
export async function editNoteHeaderTags(
  indexDb: IndexDb,
  noteId: string,
  headerTags: HeaderTagEdit
): Promise<void> {
  if (!writableTagCarrier(indexDb, noteId)) return
  await updateNoteCommand({ id: noteId, headerTags })
}
