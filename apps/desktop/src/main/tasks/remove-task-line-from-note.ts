/**
 * Delete a task's `- [ ] Title {task:<id>}` line from the note it came from.
 *
 * A task created inside a note keeps that note in `sourceNoteId`, and the line
 * is addressed by its `{task:<id>}` suffix rather than by a stored offset. The
 * row is gone by the time this runs, so nothing resurrects the task, but the
 * note still renders a checkbox for it until the line goes too.
 *
 * Only the task's OWN line is removed. Anything nested under it — a sub-bullet,
 * a continuation paragraph, a child task's line — is content this delete did
 * not ask about, and unrecoverable data loss is a far worse outcome than a
 * bullet that ends up one level shallower. A child task line left behind is the
 * same unresolved-task state the editor already renders for an unknown id.
 *
 * The write lands in the order proven by `vault/append-blocks.ts` and
 * `vault/rename-link-rewrite.ts`: ignore the watcher, write the file,
 * re-project the index rows, tell the renderer, then feed the CRDT body so a
 * persisted doc (and every other device) sees the removal instead of
 * overwriting it on the next writeback.
 *
 * A note whose Y.Doc is live is left alone entirely. That feed is a full
 * fragment replace with what is currently on disk, and the disk copy lags an
 * open editor by one debounced writeback — landing it while someone types
 * would throw away those keystrokes to delete one line. An open note is also
 * the case main does not need: deleting the block in the editor removes the
 * line through the normal writeback, and a delete from the task list reaches
 * the same block through `tasks:deleted` (`use-task-block-data.ts`).
 *
 * @module tasks/remove-task-line-from-note
 */

import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'

const log = createLogger('RemoveTaskLineFromNote')

/**
 * Cut every checkbox line carrying `{task:<taskId>}` out of `markdown`.
 * Returns null when there is none, so a repeat delete writes nothing.
 *
 * Splices on byte offsets rather than re-joining split lines: every surviving
 * byte, including mixed EOLs and a missing final newline, comes through
 * untouched.
 */
export function removeTaskLineFromMarkdown(markdown: string, taskId: string): string | null {
  if (!markdown.includes(`{task:${taskId}}`)) return null

  let out = ''
  let cursor = 0
  let index = 0
  let removed = false

  while (index < markdown.length) {
    const newline = markdown.indexOf('\n', index)
    const lineEnd = newline === -1 ? markdown.length : newline + 1
    const line = markdown.slice(index, newline === -1 ? markdown.length : newline)

    // The reconciler's notion of a task line, reused whole so the two can never
    // disagree about what counts as one.
    if (scanTaskCheckboxStates(line).has(taskId)) {
      out += markdown.slice(cursor, index)
      cursor = lineEnd
      removed = true
    }

    index = lineEnd
  }

  if (!removed) return null
  return out + markdown.slice(cursor)
}

/**
 * Remove the task's line from its source note, everywhere that note body lives.
 *
 * Never throws: the task row is already deleted, and a note that cannot be
 * rewritten must not fail the delete. Imports its vault and CRDT dependencies
 * lazily so the tasks publisher, which every task mutation loads, does not drag
 * the vault stack in with it.
 */
export async function removeTaskLineFromSourceNote(taskId: string, noteId: string): Promise<void> {
  try {
    await rewriteSourceNote(taskId, noteId)
  } catch (err) {
    log.warn('Failed to remove a deleted task line from its source note', { taskId, noteId, err })
    trackMainError('tasks', 'remove_task_line', err)
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

async function rewriteSourceNote(taskId: string, noteId: string): Promise<void> {
  const { getCrdtProvider } = await import('../sync/crdt-provider')
  if (getCrdtProvider().getDoc(noteId)) {
    log.info('Left a live note body alone after a task delete', { taskId, noteId })
    return
  }

  const { getIndexDatabase } = await import('../database')
  const { getNoteCacheById } = await import('@main/database/queries/notes')
  const { safeRead, atomicWrite } = await import('../vault/file-ops')
  const { parseNote, serializeParsedNote } = await import('../vault/frontmatter')
  const { syncNoteToCache } = await import('../vault/note-sync')
  const { emitNoteEvent, toAbsolutePath } = await import('../vault/notes-io')
  const { markWritebackIgnored } = await import('../sync/crdt-writeback')
  const { feedExternalEditToCrdt } = await import('../sync/crdt-external-feed')

  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, noteId)
  if (!cached) return

  const absolutePath = toAbsolutePath(cached.path)
  const original = await safeRead(absolutePath)
  if (original === null) return

  const parsedOriginal = parseNote(original, cached.path)
  const nextContent = removeTaskLineFromMarkdown(parsedOriginal.content, taskId)
  if (nextContent === null) return

  const nextFile = serializeParsedNote(parsedOriginal, nextContent, { frontmatterEdited: false })

  markWritebackIgnored(absolutePath)
  await atomicWrite(absolutePath, nextFile)

  const now = new Date().toISOString()
  const parsed = parseNote(nextFile, cached.path)
  const syncResult = syncNoteToCache(
    db,
    {
      id: noteId,
      path: cached.path,
      fileContent: nextFile,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: cached.title,
      createdAt: toIso(cached.createdAt),
      modifiedAt: now,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )

  const event: NoteUpdatedEvent = {
    id: noteId,
    changes: {
      content: parsed.content,
      modified: new Date(now),
      wordCount: syncResult.wordCount
    },
    source: 'external'
  }
  emitNoteEvent(NotesChannels.events.UPDATED, event)

  await feedExternalEditToCrdt(noteId, parsed.content)

  log.info('Removed a deleted task line from its source note', { taskId, noteId })
}
