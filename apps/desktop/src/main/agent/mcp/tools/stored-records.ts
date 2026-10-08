import { createHash } from 'node:crypto'

import { getNoteCacheById } from '../../../database/queries/notes'
import { getStatusById } from '../../../database/queries/projects'
import type { DataDb, IndexDb } from '../../../database'
import { readJournalEntry, readJournalFile } from '../../../vault/journal'
import { getNoteById } from '../../../vault/notes'
import { fileSpelledProperties } from '../../../vault/yaml-dates'
import type { StoredJournalEntry, StoredNote, StoredStatus } from './handles'

export function readStoredStatus(dataDb: DataDb, id: string): StoredStatus | null {
  return getStatusById(dataDb, id) ?? null
}

export function bodyDigest(content: string): { body_bytes: number; body_sha256: string } {
  const bytes = Buffer.from(content, 'utf8')
  return {
    body_bytes: bytes.byteLength,
    body_sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

export function noteIcon(note: {
  emoji?: string | null
  frontmatter: Record<string, unknown>
}): string | null {
  if (typeof note.emoji === 'string') return note.emoji
  return typeof note.frontmatter.emoji === 'string' ? note.frontmatter.emoji : null
}

/** Null for a filed binary, or a note moved into a journal date path (the watcher re-creates it). */
export async function readStoredNote(
  indexDb: IndexDb,
  id: string,
  folderPathOf: (notePath: string) => string | null
): Promise<StoredNote | null> {
  const fileType = getNoteCacheById(indexDb, id)?.fileType ?? 'markdown'
  const note = fileType === 'markdown' ? await getNoteById(id) : null
  if (!note) return null
  const icon = noteIcon(note)
  return {
    id: note.id,
    title: note.title,
    folder_path: folderPathOf(note.path),
    tags: note.tags,
    properties: fileSpelledProperties(note.properties),
    ...(note.contentOmitted ? { body_bytes: null, body_sha256: null } : bodyDigest(note.content)),
    ...(icon ? { icon } : {})
  }
}

export async function readStoredJournalEntry(date: string): Promise<StoredJournalEntry | null> {
  const [entry, file] = await Promise.all([readJournalEntry(date), readJournalFile(date)])
  if (!entry || !file) return null
  return {
    id: entry.id,
    date: entry.date,
    tags: entry.tags,
    properties: fileSpelledProperties(entry.properties ?? {}),
    ...bodyDigest(file.body)
  }
}

/**
 * Run a journal rewrite and name the frontmatter keys it dropped. The writer
 * keeps user keys and legacy id/created/modified, but drops any other key
 * Memry reserves, such as a legacy `emoji`.
 */
export async function withDroppedJournalKeys(
  date: string,
  rewrite: () => Promise<{ id: string }>
): Promise<{ id: string; frontmatter_removed?: string[] }> {
  const before = (await readJournalFile(date))?.frontmatter ?? {}
  const { id } = await rewrite()
  const after = (await readJournalFile(date))?.frontmatter ?? {}
  const dropped = Object.keys(before).filter((key) => !Object.hasOwn(after, key))
  return { id, ...(dropped.length > 0 ? { frontmatter_removed: dropped } : {}) }
}

/**
 * A markdown note's frontmatter as the file holds it. Taken from the file, not
 * the index: the index keeps a YAML date as a JSON string, and writing that
 * back would turn the date into text.
 */
export async function noteFileFrontmatter(
  indexDb: IndexDb,
  entityId: string
): Promise<Record<string, unknown>> {
  const cached = getNoteCacheById(indexDb, entityId)
  if (!cached || cached.date || (cached.fileType ?? 'markdown') !== 'markdown') return {}
  return (await getNoteById(entityId))?.frontmatter ?? {}
}
