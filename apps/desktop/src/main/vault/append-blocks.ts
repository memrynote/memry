/**
 * Append markdown to the end of a note that the renderer may not have open —
 * the target half of the block side menu's "Move to".
 *
 * The renderer can only write a note body through a mounted editor (Yjs →
 * `crdt:apply-update` → debounced writeback). "Move to" needs to write a note
 * that is usually closed, so the write happens here, in the same order the
 * watcher lands an out-of-app edit — the order proven by
 * `rename-link-rewrite.ts` in this folder:
 *
 *  1. `markWritebackIgnored` so the watcher does not re-ingest our own write,
 *  2. `atomicWrite` the file,
 *  3. `syncNoteToCache` to re-project the index rows,
 *  4. `notes:updated` with `source: 'external'` for the renderer,
 *  5. `await feedExternalEditToCrdt` for the note's CRDT body.
 *
 * Step 5 is not optional. `notes:update` and the MCP `vault_update_note` append
 * mode both skip it, and because `syncNoteToCache` refreshes `contentHash`
 * first, the watcher's dedupe (`vault/watcher.ts`) returns early and never
 * feeds the CRDT either — so when the target note IS open, its Y.Doc keeps the
 * pre-append body and the next writeback overwrites the appended text. Awaiting
 * the feed here is what makes a move into an open note survive.
 *
 * @module vault/append-blocks
 */

import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'
import { rewriteNoteRefsForMove } from '@memry/editor-schema/note-refs'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { parseNote, serializeParsedNote } from './frontmatter'
import { syncNoteToCache } from './note-sync'
import { safeRead, atomicWrite } from './file-ops'
import { emitNoteEvent, toAbsolutePath } from './notes-io'
import { createLogger } from '../lib/logger'

const log = createLogger('AppendBlocks')

export interface AppendBlocksInput {
  sourceNoteId: string
  targetNoteId: string
  markdown: string
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

/**
 * Append `markdown` to the end of the target note's body.
 *
 * Throws on a missing/unreadable note so the renderer keeps the block in the
 * source note — a failed move must never lose content.
 */
export async function appendBlocksToNote(
  input: AppendBlocksInput
): Promise<{ targetPath: string }> {
  const { sourceNoteId, targetNoteId, markdown } = input

  if (!markdown.trim()) throw new Error('Nothing to append')
  if (sourceNoteId === targetNoteId) throw new Error('Source and target note are the same')

  const db = getIndexDatabase()
  const target = getNoteCacheById(db, targetNoteId)
  if (!target) throw new Error(`Target note not found: ${targetNoteId}`)
  const source = getNoteCacheById(db, sourceNoteId)
  if (!source) throw new Error(`Source note not found: ${sourceNoteId}`)

  const absolutePath = toAbsolutePath(target.path)
  const original = await safeRead(absolutePath)
  if (original === null) throw new Error(`Target note is unreadable: ${target.path}`)

  // Attachment/image refs in the moved slice are relative to the SOURCE note's
  // folder. Same folder is a no-op (returns null); across folders this is the
  // same surgical `../` arithmetic `moveNote` uses.
  const rewritten = rewriteNoteRefsForMove(markdown, source.path, target.path) ?? markdown

  const parsedOriginal = parseNote(original, target.path)
  const head = parsedOriginal.content.replace(/\s+$/, '')
  const nextContent = head ? `${head}\n\n${rewritten.trim()}` : rewritten.trim()
  // `serializeParsedNote` re-applies the file's dominant EOL and final-newline
  // presence, and leaves the raw frontmatter block byte-identical.
  const nextFile = serializeParsedNote(parsedOriginal, nextContent, { frontmatterEdited: false })

  markWritebackIgnored(absolutePath)
  await atomicWrite(absolutePath, nextFile)

  const now = new Date().toISOString()
  const parsed = parseNote(nextFile, target.path)
  const syncResult = syncNoteToCache(
    db,
    {
      id: targetNoteId,
      path: target.path,
      fileContent: nextFile,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: target.title,
      createdAt: toIso(target.createdAt),
      modifiedAt: now,
      localOnly: target.localOnly ?? false,
      emoji: target.emoji ?? null
    },
    { isNew: false }
  )

  const event: NoteUpdatedEvent = {
    id: targetNoteId,
    changes: {
      content: parsed.content,
      modified: new Date(now),
      wordCount: syncResult.wordCount
    },
    source: 'external'
  }
  emitNoteEvent(NotesChannels.events.UPDATED, event)

  await feedExternalEditToCrdt(targetNoteId, parsed.content)

  log.info('Appended blocks to note', { targetNoteId, sourceNoteId, chars: rewritten.length })

  return { targetPath: target.path }
}
