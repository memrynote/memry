import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { desc, eq } from 'drizzle-orm'
import { noteCache, noteSnapshots, type SnapshotReason } from '@memry/db-schema/index-schema'
import type { IndexDb } from './database.ts'
import { createId } from '@memry/app-core/ids'
import { parseMarkdownNote } from '@memry/app-core/markdown'
import type { NotesService } from './notes.ts'

export interface SnapshotListItem {
  id: string
  noteId: string
  title: string
  wordCount: number
  reason: SnapshotReason
  createdAt: string
}

export interface SnapshotDetail extends SnapshotListItem {
  fileContent: string
}

export interface VersionsService {
  create(noteId: string, reason?: SnapshotReason, force?: boolean): Promise<SnapshotListItem | null>
  history(noteId: string, limit?: number): Promise<SnapshotListItem[]>
  get(snapshotId: string): Promise<SnapshotDetail | null>
  restore(snapshotId: string): Promise<Awaited<ReturnType<NotesService['update']>>>
  delete(snapshotId: string): Promise<boolean>
}

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function toListItem(row: typeof noteSnapshots.$inferSelect): SnapshotListItem {
  return {
    id: row.id,
    noteId: row.noteId,
    title: row.title,
    wordCount: row.wordCount,
    reason: row.reason as SnapshotReason,
    createdAt: row.createdAt
  }
}

function toDetail(row: typeof noteSnapshots.$inferSelect): SnapshotDetail {
  return {
    ...toListItem(row),
    fileContent: row.fileContent
  }
}

function upsertNoteCache(
  indexDb: IndexDb,
  note: NonNullable<Awaited<ReturnType<NotesService['get']>>>,
  contentHash: string
): void {
  indexDb
    .insert(noteCache)
    .values({
      id: note.id,
      path: note.path,
      title: note.title,
      fileType: 'markdown',
      contentHash,
      wordCount: note.wordCount,
      snippet: note.snippet,
      date: note.journalDate,
      createdAt: note.createdAt,
      modifiedAt: note.modifiedAt
    })
    .onConflictDoUpdate({
      target: noteCache.id,
      set: {
        path: note.path,
        title: note.title,
        contentHash,
        wordCount: note.wordCount,
        snippet: note.snippet,
        date: note.journalDate,
        modifiedAt: note.modifiedAt
      }
    })
    .run()
}

export function createVersionsService({
  vaultPath,
  indexDb,
  notes
}: {
  vaultPath: string
  indexDb: IndexDb
  notes: NotesService
}): VersionsService {
  return {
    async create(noteId, reason = 'manual', force = false) {
      const note = await notes.get(noteId)
      if (!note) throw new Error(`Note not found: ${noteId}`)
      const fileContent = await fs.readFile(path.join(vaultPath, note.path), 'utf-8')
      const contentHash = hash(fileContent)
      upsertNoteCache(indexDb, note, contentHash)

      if (!force) {
        const existing = indexDb
          .select()
          .from(noteSnapshots)
          .where(eq(noteSnapshots.contentHash, contentHash))
          .all()
          .find((snapshot) => snapshot.noteId === noteId)
        if (existing) return null
      }

      const row = indexDb
        .insert(noteSnapshots)
        .values({
          id: createId('snapshot'),
          noteId,
          fileContent,
          title: note.title,
          wordCount: note.wordCount,
          contentHash,
          reason
        })
        .returning()
        .get()
      return toListItem(row)
    },

    async history(noteId, limit = 50) {
      return indexDb
        .select()
        .from(noteSnapshots)
        .where(eq(noteSnapshots.noteId, noteId))
        .orderBy(desc(noteSnapshots.createdAt))
        .limit(limit)
        .all()
        .map(toListItem)
    },

    async get(snapshotId) {
      const row = indexDb.select().from(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).get()
      return row ? toDetail(row) : null
    },

    async restore(snapshotId) {
      const snapshot = await this.get(snapshotId)
      if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`)

      const note = await notes.get(snapshot.noteId)
      if (!note) throw new Error(`Note not found: ${snapshot.noteId}`)
      await this.create(note.id, 'significant', true)

      const parsed = parseMarkdownNote(snapshot.fileContent)
      const tags = Array.isArray(parsed.frontmatter.tags)
        ? parsed.frontmatter.tags.map((tag) => String(tag))
        : []
      const properties =
        parsed.frontmatter.properties &&
        typeof parsed.frontmatter.properties === 'object' &&
        !Array.isArray(parsed.frontmatter.properties)
          ? (parsed.frontmatter.properties as Record<string, unknown>)
          : {}

      return notes.update({
        id: snapshot.noteId,
        title: snapshot.title,
        content: parsed.content,
        tags,
        properties
      })
    },

    async delete(snapshotId) {
      indexDb.delete(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).run()
      return true
    }
  }
}
