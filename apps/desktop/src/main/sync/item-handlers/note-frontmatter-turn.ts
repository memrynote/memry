/**
 * A remote frontmatter rewrite that a write-back pass read before.
 *
 * `noteHandler.applyUpsert` rewrites a note's tags, properties, cover or
 * aliases synchronously, inside the apply, so it cannot wait for the note's
 * write-back turn. A pass that read the file before the rewrite writes back
 * the frontmatter it read, and the rewrite left the doc as it was, so nothing
 * re-arms the pass (#5479). While a pass is pending or running, the same patch
 * is applied again right after the running turn, ahead of local edits queued
 * behind it, so a later local edit lands on top of the remote record instead
 * of under it. The patch is idempotent, so a file that already holds it is not
 * written.
 *
 * @module sync/item-handlers/note-frontmatter-turn
 */

import fs from 'fs'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../../database/client'
import { readVaultFile } from '../../lib/paths'
import { createLogger } from '../../lib/logger'
import { parseNote, serializeParsedNote } from '../../vault/frontmatter'
import { getVaultRoot, toAbsolutePath } from '../../vault/notes'
import { syncNoteToCache } from '../../vault/note-sync'
import { settleRemoteNoteFileSync, writeThroughLock } from '../../vault-locks/files'
import { recordAppWrite } from '../../vault/app-writes'
import { hasPendingWriteback, repairAfterRunningTurn } from '../crdt-writeback'
import { baselineAfterWrite } from '../writeback-baseline'
import { applyRemoteFrontmatter, type RemoteFrontmatterPatch } from './note-handler-frontmatter'

const log = createLogger('NoteHandler')

export function reapplyRemoteFrontmatterAfterPass(
  noteId: string,
  patch: RemoteFrontmatterPatch
): void {
  if (!hasPendingWriteback(noteId)) return
  repairAfterRunningTurn(noteId, () =>
    reapply(noteId, patch).catch((err: unknown) => {
      log.error('Could not re-apply a remote frontmatter update after a write-back', {
        noteId,
        err
      })
    })
  )
}

async function reapply(noteId: string, patch: RemoteFrontmatterPatch): Promise<void> {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  if (!cached) return
  const raw = await readVaultFile(getVaultRoot(), cached.path)
  if (raw === null) return
  const parsed = parseNote(raw)
  parsed.frontmatter = applyRemoteFrontmatter(parsed.frontmatter, patch)
  const updated = serializeParsedNote(parsed, parsed.content, { frontmatterEdited: true })
  if (updated === raw) return
  const absPath = toAbsolutePath(cached.path)
  const landed = recordAppWrite(absPath, updated)
  await writeThroughLock(absPath, async () => {
    await fs.promises.writeFile(`${absPath}.tmp`, updated, 'utf-8')
    await fs.promises.rename(`${absPath}.tmp`, absPath)
    return updated
  })
  landed()
  settleRemoteNoteFileSync(noteId, absPath, cached.path, updated)
  syncNoteToCache(
    indexDb,
    {
      id: noteId,
      path: cached.path,
      fileContent: updated,
      contentHash: baselineAfterWrite(indexDb, noteId, raw, updated),
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: cached.title,
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false, source: 'sync' }
  )
}
