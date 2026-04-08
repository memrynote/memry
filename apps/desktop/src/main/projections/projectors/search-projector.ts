import fs from 'fs/promises'
import path from 'path'
import { BrowserWindow } from 'electron'
import { sql } from 'drizzle-orm'
import { SearchChannels } from '@memry/contracts/ipc-channels'
import { getDatabase, getIndexDatabase } from '../../database'
import { clearFtsTable, deleteFtsNote, insertFtsNote } from '../../database/fts'
import { clearFtsTasksTable, deleteFtsTask, insertFtsTask } from '../../database/fts-tasks'
import {
  clearFtsInboxTable,
  deleteFtsInboxItem,
  insertFtsInboxItem
} from '../../database/fts-inbox'
import { parseNote } from '../../vault/frontmatter'
import { createLogger } from '../../lib/logger'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:Search')

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
  clearFtsTable(indexDb)

  const vaultPath = getVaultPath()
  if (!vaultPath) {
    return 0
  }

  const rows = indexDb.all<{ id: string; title: string; path: string; fileType: string | null }>(sql`
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
      insertFtsNote(indexDb, row.id, row.title, parsed.content, tagsByNote.get(row.id) ?? [])
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
  clearFtsTasksTable(dataDb)

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
  clearFtsInboxTable(dataDb)

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

    async reconcile(): Promise<void> {
      await rebuildNotes(getVaultPath)
      rebuildTasks()
      rebuildInbox()
    }
  }
}
