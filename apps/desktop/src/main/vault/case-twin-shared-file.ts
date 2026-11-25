/**
 * Whether case twins share a note's file, and whether the bytes there are the
 * note's own. A leaf of the case twin modules: the sync payload asks it
 * without importing the twin file steps.
 *
 * @module vault/case-twin-shared-file
 */

import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { readVaultFileSync } from '../lib/paths'
import { diskCaseOf } from './disk-case'
import { findCanonicalNoteForFile } from './note-sync'
import { holdsOwnBytes, ownHeader } from './case-twin-own-file'
import type { NoteFrontmatter } from './frontmatter'

/** Whether a case twin shares this note's file. Ask before the note's row leaves it. */
export function sharesCaseTwinFile(vaultPath: string, relativePath: string): boolean {
  const onDisk = diskCaseOf(vaultPath, relativePath)
  return onDisk !== null && findCanonicalNoteForFile(vaultPath, onDisk)?.sharesFile === true
}

/**
 * Whether note `noteId` shares its file with a case twin and the bytes there
 * are not its own: patching them would put the other twin's body under this
 * note's header.
 */
export function isCaseTwinOffFile(
  vaultPath: string,
  relativePath: string,
  noteId: string
): boolean {
  if (!sharesCaseTwinFile(vaultPath, relativePath)) return false
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  const raw = readVaultFileSync(vaultPath, relativePath)
  return raw === null || !cached || !holdsOwnBytes(raw, cached)
}

/**
 * Note `noteId`'s own header when its shared file holds the other twin's bytes
 * (`isCaseTwinOffFile`), for a push of the note; null when its file holds its
 * header.
 */
export function caseTwinOffFileHeader(
  vaultPath: string,
  relativePath: string,
  noteId: string
): NoteFrontmatter | null {
  if (!isCaseTwinOffFile(vaultPath, relativePath, noteId)) return null
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  return cached ? ownHeader(indexDb, noteId, cached.title, cached) : null
}
