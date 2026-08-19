import fs from 'fs/promises'
import path from 'path'
import { sql } from 'drizzle-orm'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { getDatabase, getIndexDatabase } from '../../database'
import {
  dedupeFtsNotes,
  deleteFtsNote,
  insertFtsNote,
  insertFtsNoteUnchecked,
  resetFtsTable
} from '../../database/fts'
import {
  dedupeFtsTasks,
  deleteFtsTask,
  insertFtsTask,
  resetFtsTasksTable
} from '../../database/fts-tasks'
import {
  dedupeFtsInbox,
  deleteFtsInboxItem,
  insertFtsInboxItem,
  resetFtsInboxTable
} from '../../database/fts-inbox'
import { getSetting, setSetting } from '../../database/queries/settings'
import { parseNote } from '../../vault/frontmatter'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:Search')

interface RebuildProgress {
  phase: string
  current: number
  total: number
}

function broadcast(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

function getTaskTags(taskId: string): string[] {
  const dataDb = getDatabase()
  return dataDb
    .all<{ tag: string }>(sql`SELECT tag FROM task_tags WHERE task_id = ${taskId}`)
    .map((row) => row.tag)
}

function upsertTask(taskId: string): void {
  const dataDb = getDatabase()
  const task = dataDb.get<{ id: string; title: string; description: string | null }>(sql`
    SELECT id, title, description
    FROM tasks
    WHERE id = ${taskId}
  `)

  if (!task) {
    deleteFtsTask(dataDb, taskId)
    return
  }

  insertFtsTask(dataDb, task.id, task.title, task.description ?? '', getTaskTags(taskId))
}

function upsertInboxItem(itemId: string): void {
  const dataDb = getDatabase()
  const item = dataDb.get<{
    id: string
    title: string
    content: string | null
    transcription: string | null
    sourceTitle: string | null
  }>(sql`
    SELECT id, title, content, transcription, source_title as sourceTitle
    FROM inbox_items
    WHERE id = ${itemId}
  `)

  if (!item) {
    deleteFtsInboxItem(dataDb, itemId)
    return
  }

  insertFtsInboxItem(
    dataDb,
    item.id,
    item.title,
    item.content ?? '',
    item.transcription ?? '',
    item.sourceTitle ?? ''
  )
}

async function rebuildNotes(getVaultPath: () => string | null): Promise<number> {
  const indexDb = getIndexDatabase()
  // Drop-and-recreate, not `DELETE FROM fts_notes`. Rebuild is the escape hatch
  // for an index that is already broken, and emptying a corrupt fts5 table
  // means reading the structures that are broken: the delete threw
  // SQLITE_CORRUPT and the user's "Rebuild search index" button failed at its
  // very first statement, leaving them stuck (#1585).
  resetFtsTable(indexDb)

  const vaultPath = getVaultPath()
  if (!vaultPath) {
    return 0
  }

  const rows = indexDb.all<{
    id: string
    title: string
    path: string
    fileType: string | null
  }>(sql`
    SELECT id, title, path, file_type as fileType
    FROM note_cache
    WHERE COALESCE(file_type, 'markdown') = 'markdown'
  `)

  const tagRows = indexDb.all<{ noteId: string; tag: string }>(
    sql`SELECT note_id as noteId, tag FROM note_tags`
  )
  const tagsByNote = new Map<string, string[]>()
  for (const row of tagRows) {
    const tags = tagsByNote.get(row.noteId) ?? []
    tags.push(row.tag)
    tagsByNote.set(row.noteId, tags)
  }

  let indexed = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const absolutePath = path.join(vaultPath, row.path)

    try {
      const raw = await fs.readFile(absolutePath, 'utf-8')
      const parsed = parseNote(raw, row.path)
      // resetFtsTable above left the table empty, so every id here is absent.
      insertFtsNoteUnchecked(
        indexDb,
        row.id,
        row.title,
        parsed.content,
        tagsByNote.get(row.id) ?? []
      )
      indexed++
    } catch (error) {
      logger.warn('Failed to rebuild note search entry', { noteId: row.id, error })
    }

    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'notes',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return indexed
}

function rebuildTasks(): number {
  const dataDb = getDatabase()
  // Drop-and-recreate for the same reason as rebuildNotes above.
  resetFtsTasksTable(dataDb)

  const rows = dataDb.all<{ id: string }>(sql`SELECT id FROM tasks`)
  for (let i = 0; i < rows.length; i++) {
    upsertTask(rows[i].id)
    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'tasks',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return rows.length
}

function rebuildInbox(): number {
  const dataDb = getDatabase()
  // Drop-and-recreate for the same reason as rebuildNotes above.
  resetFtsInboxTable(dataDb)

  const rows = dataDb.all<{ id: string }>(sql`SELECT id FROM inbox_items`)
  for (let i = 0; i < rows.length; i++) {
    upsertInboxItem(rows[i].id)
    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'inbox',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return rows.length
}

/** How many files reconcile stats at once before yielding to the event loop. */
const STAT_BATCH_SIZE = 64

/**
 * Marks the one-time duplicate-row sweep as done. Local per install: it
 * describes the state of this device's FTS tables, and the `settings` table is
 * the codebase's existing home for that (`ai.embeddingInputVersion` is the same
 * pattern). Arbitrary rows here do not sync — `SyncedSettingsSchema` is a
 * closed shape — so one device finishing its sweep cannot make another skip its
 * own.
 *
 * Bump the version to force a re-sweep for everyone in a future release. It
 * deliberately does NOT cover a user who downgrades to a build with the append
 * bug, re-accumulates duplicates and upgrades again: the marker is already set,
 * so their sweep stays skipped until either this constant is bumped or they run
 * "Rebuild search index", which clears the tables outright.
 */
const FTS_DEDUPE_VERSION_KEY = 'search.ftsDedupeVersion'
const FTS_DEDUPE_VERSION = 1

/**
 * Repairs rows appended by builds where the FTS inserts never replaced.
 *
 * Gated because it is a full fts5 scan per table and the defect it repairs can
 * only have happened once — the insert path is correct now. Leaving it ungated
 * would put a permanent per-launch scan on every vault to clean up a historical
 * one-off.
 *
 * The marker is written last and only on a completed run, so an interrupted
 * sweep is simply retried on the next open.
 */
function sweepDuplicateFtsRows(signal?: AbortSignal): void {
  if (signal?.aborted) {
    return
  }

  const dataDb = getDatabase()
  if (getSetting(dataDb, FTS_DEDUPE_VERSION_KEY) === String(FTS_DEDUPE_VERSION)) {
    return
  }

  dedupeFtsNotes(getIndexDatabase())
  dedupeFtsTasks(dataDb)
  dedupeFtsInbox(dataDb)

  setSetting(dataDb, FTS_DEDUPE_VERSION_KEY, String(FTS_DEDUPE_VERSION))
  logger.info('Swept duplicate FTS rows left by an earlier build', {
    version: FTS_DEDUPE_VERSION
  })
}

/**
 * Slack between a file's mtime and the moment we recorded having indexed it.
 * FAT/SMB timestamps are 2s-granular and can round up past the `indexed_at`
 * we wrote right after the file, which would otherwise re-read those notes on
 * every single open. The window only has to be smaller than "the app was
 * closed while someone edited the vault", which it is by orders of magnitude.
 */
const MTIME_TOLERANCE_MS = 2000

interface NoteRow {
  id: string
  title: string
  path: string
  indexedAt: string
}

/**
 * Reconcile repairs divergence instead of rewriting everything.
 *
 * It used to call the rebuild helpers on every vault open — `DELETE FROM
 * fts_*` followed by a full disk re-scan — which cost thousands of file reads
 * and a complete FTS5 rewrite for an index that was already correct, and left
 * search empty if the process died mid-pass.
 *
 * A note is now re-read only when it has no FTS row, or when its file is newer
 * than the `note_cache.indexed_at` stamp written the last time we processed it.
 * That second half is not optional: `indexFile` returns 'skipped' for any path
 * already in the cache without comparing mtimes and the watcher only starts
 * afterwards, so a note edited outside Memry while the app was closed never
 * produces a `note.upserted` event — the full re-scan was the only thing
 * keeping search results fresh for it.
 *
 * `indexed_at` rather than `modified_at` because every writer of a cache row
 * stamps it (`insertNoteCache`/`updateNoteCache`), always after the file is on
 * disk, whereas `modified_at` is whatever the writer passed: fs mtime from the
 * indexer, the local clock from note CRUD, the *remote* clock from a sync pull.
 * Comparing against that would re-read every synced note on every open forever.
 *
 * `rebuild()` keeps the full teardown as the repair path for a corrupt index
 * (#993).
 */
async function reconcileNotes(
  getVaultPath: () => string | null,
  signal?: AbortSignal
): Promise<number> {
  const vaultPath = getVaultPath()
  if (!vaultPath || signal?.aborted) {
    return 0
  }

  const indexDb = getIndexDatabase()

  indexDb.run(sql`
    DELETE FROM fts_notes
    WHERE id NOT IN (
      SELECT id
      FROM note_cache
      WHERE COALESCE(file_type, 'markdown') = 'markdown'
    )
  `)

  const indexedIds = new Set(
    indexDb.all<{ id: string }>(sql`SELECT id FROM fts_notes`).map((row) => row.id)
  )

  const rows = indexDb.all<NoteRow>(sql`
    SELECT id, title, path, indexed_at as indexedAt
    FROM note_cache
    WHERE COALESCE(file_type, 'markdown') = 'markdown'
  `)

  const stale = await selectStaleNotes(rows, indexedIds, vaultPath, signal)
  if (signal?.aborted) {
    return 0
  }

  let indexed = 0
  for (let i = 0; i < stale.length; i++) {
    const row = stale[i]
    const absolutePath = path.join(vaultPath, row.path)

    try {
      const raw = await fs.readFile(absolutePath, 'utf-8')

      // The read is the only await in this loop, so it is the only point an
      // abort can land. Bail before writing: closeVault closes the databases
      // as soon as the runtime stops.
      if (signal?.aborted) {
        break
      }

      const parsed = parseNote(raw, row.path)
      const tags = indexDb
        .all<{ tag: string }>(sql`SELECT tag FROM note_tags WHERE note_id = ${row.id}`)
        .map((tagRow) => tagRow.tag)

      // `indexedIds` was taken after the dedupe and orphan sweeps and nothing
      // else writes this table during the pass, so it is authoritative: absent
      // means absent, and skipping the scan keeps a cold-index backfill linear.
      if (indexedIds.has(row.id)) {
        insertFtsNote(indexDb, row.id, row.title, parsed.content, tags)
      } else {
        insertFtsNoteUnchecked(indexDb, row.id, row.title, parsed.content, tags)
      }
      indexed++
    } catch (error) {
      logger.warn('Failed to reconcile note search entry', { noteId: row.id, error })
    }

    if ((i + 1) % 100 === 0 || i === stale.length - 1) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'notes',
        current: i + 1,
        total: stale.length
      } satisfies RebuildProgress)
    }
  }

  return indexed
}

/**
 * Narrow every cached markdown note down to the ones worth re-reading. A `stat`
 * is a fraction of the cost of the `readFile` + `parseNote` + `insertFtsNote`
 * it replaces, and the batches keep the event loop responsive while giving the
 * abort a place to land.
 */
async function selectStaleNotes(
  rows: NoteRow[],
  indexedIds: Set<string>,
  vaultPath: string,
  signal?: AbortSignal
): Promise<NoteRow[]> {
  const stale: NoteRow[] = []

  for (let start = 0; start < rows.length; start += STAT_BATCH_SIZE) {
    if (signal?.aborted) {
      return stale
    }

    const batch = rows.slice(start, start + STAT_BATCH_SIZE)
    const verdicts = await Promise.all(
      batch.map(async (row) => {
        // Never indexed — no need to ask the filesystem anything.
        if (!indexedIds.has(row.id)) {
          return true
        }

        const stats = await fs.stat(path.join(vaultPath, row.path)).catch(() => null)
        if (!stats) {
          // Vanished or unreadable. Pruning the cache row belongs to the
          // note-derived-state projector; leave the FTS row for it to trigger.
          return false
        }

        const indexedAtMs = Date.parse(row.indexedAt)
        if (Number.isNaN(indexedAtMs)) {
          return true
        }

        return stats.mtimeMs > indexedAtMs + MTIME_TOLERANCE_MS
      })
    )

    for (let i = 0; i < batch.length; i++) {
      if (verdicts[i]) {
        stale.push(batch[i])
      }
    }
  }

  return stale
}

// Tasks and inbox items are read straight from the data DB, so these passes are
// synchronous: an abort can only have landed while reconcileNotes was awaiting a
// file read, which is why the signal is checked once, up front.
function reconcileTasks(signal?: AbortSignal): number {
  if (signal?.aborted) {
    return 0
  }

  const dataDb = getDatabase()

  dataDb.run(sql`DELETE FROM fts_tasks WHERE id NOT IN (SELECT id FROM tasks)`)

  const rows = dataDb.all<{ id: string }>(sql`
    SELECT id FROM tasks WHERE id NOT IN (SELECT id FROM fts_tasks)
  `)

  for (const row of rows) {
    upsertTask(row.id)
  }

  return rows.length
}

function reconcileInbox(signal?: AbortSignal): number {
  if (signal?.aborted) {
    return 0
  }

  const dataDb = getDatabase()

  dataDb.run(sql`DELETE FROM fts_inbox WHERE id NOT IN (SELECT id FROM inbox_items)`)

  const rows = dataDb.all<{ id: string }>(sql`
    SELECT id FROM inbox_items WHERE id NOT IN (SELECT id FROM fts_inbox)
  `)

  for (const row of rows) {
    upsertInboxItem(row.id)
  }

  return rows.length
}

export function createSearchProjector(getVaultPath: () => string | null): ProjectionProjector {
  return {
    name: 'search',

    handles(event: ProjectionEvent): boolean {
      return (
        event.type === 'note.upserted' ||
        event.type === 'note.deleted' ||
        event.type === 'task.upserted' ||
        event.type === 'task.deleted' ||
        event.type === 'inbox.upserted' ||
        event.type === 'inbox.deleted'
      )
    },

    async project(event: ProjectionEvent): Promise<void> {
      switch (event.type) {
        case 'note.upserted': {
          if (event.note.kind !== 'markdown') {
            deleteFtsNote(getIndexDatabase(), event.note.noteId)
            return
          }

          // Body not read yet (tier 0 of ingest). The idle backfill republishes
          // the note with its body and that is what reaches the index; writing
          // an empty row here would put an FTS write back on the add path.
          if (event.note.parsedContent === null) {
            return
          }

          insertFtsNote(
            getIndexDatabase(),
            event.note.noteId,
            event.note.title,
            event.note.parsedContent,
            event.note.tags
          )
          return
        }
        case 'note.deleted':
          deleteFtsNote(getIndexDatabase(), event.noteId)
          return
        case 'task.upserted':
          upsertTask(event.taskId)
          return
        case 'task.deleted':
          deleteFtsTask(getDatabase(), event.taskId)
          return
        case 'inbox.upserted':
          upsertInboxItem(event.itemId)
          return
        case 'inbox.deleted':
          deleteFtsInboxItem(getDatabase(), event.itemId)
          return
        default:
          return
      }
    },

    async rebuild(): Promise<{
      notes: number
      tasks: number
      inbox: number
      durationMs: number
    }> {
      const startTime = performance.now()

      broadcast(SearchChannels.events.INDEX_REBUILD_STARTED, {
        tables: ['fts_notes', 'fts_tasks', 'fts_inbox']
      })

      const notes = await rebuildNotes(getVaultPath)
      const tasks = rebuildTasks()
      const inbox = rebuildInbox()
      const durationMs = Math.round(performance.now() - startTime)

      broadcast(SearchChannels.events.INDEX_REBUILD_COMPLETED, {
        notes,
        tasks,
        inbox,
        durationMs
      })

      return { notes, tasks, inbox, durationMs }
    },

    async reconcile(signal?: AbortSignal): Promise<void> {
      // Before reconcileNotes reads its membership set, so the set never sees
      // the duplicates.
      sweepDuplicateFtsRows(signal)

      await reconcileNotes(getVaultPath, signal)
      reconcileTasks(signal)
      reconcileInbox(signal)
    }
  }
}
