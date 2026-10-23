// Mirrors desktop's search projector rebuild (apps/desktop/src/main/projections/projectors/
// search-projector.ts): drop and recreate fts_notes, fts_tasks and fts_inbox, then repopulate
// them from note_cache, the note files, tasks and inbox items. It deliberately does not add
// note_cache rows. Desktop's indexer skips any path already in the cache, so a CLI-written row
// would stop it from projecting that note's links, names and properties.
import fs from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { parseMarkdownNote } from '@memry/app-core/markdown'
import type { DataDb, IndexDb } from './database.ts'

export interface ReindexResult {
  notes: number
  tasks: number
  inbox: number
  skipped: number
  durationMs: number
}

function resetNotesTable(db: IndexDb): void {
  db.run(sql`DROP TABLE IF EXISTS fts_notes`)
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
      id UNINDEXED, title, content, tags, tokenize='porter unicode61'
    )
  `)
}

function resetTasksTable(db: DataDb): void {
  db.run(sql`DROP TABLE IF EXISTS fts_tasks`)
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
      id UNINDEXED, title, description, tags, tokenize='porter unicode61'
    )
  `)
}

function resetInboxTable(db: DataDb): void {
  db.run(sql`DROP TABLE IF EXISTS fts_inbox`)
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_inbox USING fts5(
      id UNINDEXED, title, content, transcription, source_title, tokenize='porter unicode61'
    )
  `)
}

function extractedTextByNote(indexDb: IndexDb): Map<string, string> {
  const rows = indexDb.all<{ noteId: string; text: string }>(sql`
    SELECT note_id as noteId, text FROM extracted_text
    WHERE text != '' ORDER BY note_id, source, part
  `)
  const byNote = new Map<string, string[]>()
  for (const row of rows) byNote.set(row.noteId, [...(byNote.get(row.noteId) ?? []), row.text])
  return new Map([...byNote].map(([id, parts]) => [id, parts.join('\n\n')]))
}

export async function reindexSearch({
  vaultPath,
  indexDb,
  dataDb
}: {
  vaultPath: string
  indexDb: IndexDb
  dataDb: DataDb
}): Promise<ReindexResult> {
  const startedAt = performance.now()
  const root = path.resolve(vaultPath)

  resetNotesTable(indexDb)
  const extracted = extractedTextByNote(indexDb)
  const tagsByNote = new Map<string, string[]>()
  for (const row of indexDb.all<{ noteId: string; tag: string }>(
    sql`SELECT note_id as noteId, tag FROM note_tags`
  )) {
    tagsByNote.set(row.noteId, [...(tagsByNote.get(row.noteId) ?? []), row.tag])
  }

  const insertNote = (id: string, title: string, content: string, tags: string[]): void => {
    indexDb.run(sql`
      INSERT INTO fts_notes (id, title, content, tags) VALUES (${id}, ${title}, ${content}, ${tags.join(' ')})
    `)
  }

  let notes = 0
  let skipped = 0
  const noteRows = indexDb.all<{
    id: string
    title: string
    path: string
    fileType: string | null
  }>(sql`SELECT id, title, path, file_type as fileType FROM note_cache`)
  for (const row of noteRows) {
    if ((row.fileType ?? 'markdown') !== 'markdown') {
      const text = extracted.get(row.id)
      if (text) {
        insertNote(row.id, row.title, text, [])
        notes += 1
      }
      continue
    }
    const absolute = path.resolve(root, row.path)
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      skipped += 1
      continue
    }
    try {
      const body = parseMarkdownNote(await fs.readFile(absolute, 'utf-8')).content
      const attachmentText = extracted.get(row.id)
      insertNote(
        row.id,
        row.title,
        attachmentText ? `${body}\n\n${attachmentText}` : body,
        tagsByNote.get(row.id) ?? []
      )
      notes += 1
    } catch {
      // A cache row whose file is gone has nothing to index; desktop's own projector
      // prunes the row. Counted so the caller can tell the index is not complete.
      skipped += 1
    }
  }

  resetTasksTable(dataDb)
  const taskTags = new Map<string, string[]>()
  for (const row of dataDb.all<{ taskId: string; tag: string }>(
    sql`SELECT task_id as taskId, tag FROM task_tags`
  )) {
    taskTags.set(row.taskId, [...(taskTags.get(row.taskId) ?? []), row.tag])
  }
  const taskRows = dataDb.all<{ id: string; title: string; description: string | null }>(
    sql`SELECT id, title, description FROM tasks`
  )
  for (const task of taskRows) {
    dataDb.run(sql`
      INSERT INTO fts_tasks (id, title, description, tags)
      VALUES (${task.id}, ${task.title}, ${task.description ?? ''}, ${(taskTags.get(task.id) ?? []).join(' ')})
    `)
  }

  resetInboxTable(dataDb)
  const inboxRows = dataDb.all<{
    id: string
    title: string
    content: string | null
    transcription: string | null
    sourceTitle: string | null
  }>(sql`
    SELECT id, title, content, transcription, source_title as sourceTitle FROM inbox_items
  `)
  for (const item of inboxRows) {
    dataDb.run(sql`
      INSERT INTO fts_inbox (id, title, content, transcription, source_title)
      VALUES (${item.id}, ${item.title}, ${item.content ?? ''}, ${item.transcription ?? ''}, ${item.sourceTitle ?? ''})
    `)
  }

  return {
    notes,
    tasks: taskRows.length,
    inbox: inboxRows.length,
    skipped,
    durationMs: Math.round(performance.now() - startedAt)
  }
}
