import { BrowserWindow } from 'electron'
import { sql } from 'drizzle-orm'
import type { DrizzleDb } from './client'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { clearFtsTable, insertFtsNote } from './fts'
import { clearFtsTasksTable, insertFtsTask } from './fts-tasks'
import { clearFtsInboxTable, insertFtsInboxItem } from './fts-inbox'
import { createLogger } from '../lib/logger'

const logger = createLogger('FtsRebuild')

interface RebuildProgress {
  phase: string
  current: number
  total: number
}

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function isTableCorrupt(db: DrizzleDb, tableName: string): boolean {
  try {
    db.all(sql.raw(`SELECT * FROM ${tableName} WHERE ${tableName} MATCH 'test' LIMIT 1`))
    return false
  } catch {
    return true
  }
}

export function detectCorruption(indexDb: DrizzleDb, dataDb: DrizzleDb): string[] {
  const corrupt: string[] = []

  if (isTableCorrupt(indexDb, 'fts_notes')) corrupt.push('fts_notes')
  if (isTableCorrupt(dataDb, 'fts_tasks')) corrupt.push('fts_tasks')
  if (isTableCorrupt(dataDb, 'fts_inbox')) corrupt.push('fts_inbox')

  if (corrupt.length > 0) {
    logger.warn('Corrupt FTS tables detected:', corrupt)
    broadcast(SearchChannels.events.INDEX_CORRUPT, { tables: corrupt })
  }

  return corrupt
}

function rebuildNotes(indexDb: DrizzleDb): number {
  clearFtsTable(indexDb)

  const rows = indexDb.all<{
    id: string
    title: string
    content: string
    tags: string
  }>(sql`
    SELECT nc.id, nc.title, COALESCE(nc.content, '') as content, '' as tags
    FROM note_cache nc
  `)

  const tagRows = indexDb.all<{ noteId: string; tag: string }>(
    sql`SELECT note_id as noteId, tag FROM note_tags`
  )
  const tagsByNote = new Map<string, string[]>()
  for (const row of tagRows) {
    const existing = tagsByNote.get(row.noteId) ?? []
    existing.push(row.tag)
    tagsByNote.set(row.noteId, existing)
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const tags = tagsByNote.get(row.id) ?? []
    insertFtsNote(indexDb, row.id, row.title, row.content, tags)

    if ((i + 1) % 100 === 0) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'notes',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return rows.length
}

function rebuildTasks(dataDb: DrizzleDb): number {
  clearFtsTasksTable(dataDb)

  const rows = dataDb.all<{
    id: string
    title: string
    description: string
  }>(sql`
    SELECT id, title, COALESCE(description, '') as description
    FROM tasks
  `)

  const tagRows = dataDb.all<{ taskId: string; tag: string }>(
    sql`SELECT task_id as taskId, tag FROM task_tags`
  )
  const tagsByTask = new Map<string, string[]>()
  for (const row of tagRows) {
    const existing = tagsByTask.get(row.taskId) ?? []
    existing.push(row.tag)
    tagsByTask.set(row.taskId, existing)
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const tags = tagsByTask.get(row.id) ?? []
    insertFtsTask(dataDb, row.id, row.title, row.description, tags)

    if ((i + 1) % 100 === 0) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'tasks',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return rows.length
}

function rebuildInbox(dataDb: DrizzleDb): number {
  clearFtsInboxTable(dataDb)

  const rows = dataDb.all<{
    id: string
    title: string
    content: string
    transcription: string
    sourceTitle: string
  }>(sql`
    SELECT id, title,
      COALESCE(content, '') as content,
      COALESCE(transcription, '') as transcription,
      COALESCE(source_title, '') as sourceTitle
    FROM inbox_items
  `)

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    insertFtsInboxItem(dataDb, row.id, row.title, row.content, row.transcription, row.sourceTitle)

    if ((i + 1) % 100 === 0) {
      broadcast(SearchChannels.events.INDEX_REBUILD_PROGRESS, {
        phase: 'inbox',
        current: i + 1,
        total: rows.length
      } satisfies RebuildProgress)
    }
  }

  return rows.length
}

export function rebuildAllIndexes(
  indexDb: DrizzleDb,
  dataDb: DrizzleDb
): {
  notes: number
  tasks: number
  inbox: number
  durationMs: number
} {
  const startTime = performance.now()

  broadcast(SearchChannels.events.INDEX_REBUILD_STARTED, {
    tables: ['fts_notes', 'fts_tasks', 'fts_inbox']
  })

  logger.info('Starting full FTS index rebuild')

  let notes = 0
  let tasks = 0
  let inbox = 0

  try {
    notes = rebuildNotes(indexDb)
    logger.info(`Rebuilt fts_notes: ${notes} entries`)

    tasks = rebuildTasks(dataDb)
    logger.info(`Rebuilt fts_tasks: ${tasks} entries`)

    inbox = rebuildInbox(dataDb)
    logger.info(`Rebuilt fts_inbox: ${inbox} entries`)
  } catch (error) {
    logger.error('FTS rebuild failed:', error)
    throw error
  }

  const durationMs = Math.round(performance.now() - startTime)

  broadcast(SearchChannels.events.INDEX_REBUILD_COMPLETED, {
    notes,
    tasks,
    inbox,
    durationMs
  })

  logger.info(`FTS rebuild complete in ${durationMs}ms (${notes + tasks + inbox} total entries)`)

  return { notes, tasks, inbox, durationMs }
}
