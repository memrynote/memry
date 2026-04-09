import fs from 'fs/promises'
import path from 'path'
import { BrowserWindow } from 'electron'
import { sql } from 'drizzle-orm'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../../database'
import { getSetting } from '@main/database/queries/settings'
import { parseNote } from '../../vault/frontmatter'
import {
  generateEmbedding as generateLocalEmbedding,
  initEmbeddingModel,
  isModelLoaded
} from '../../lib/embeddings'
import { createLogger } from '../../lib/logger'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:Embeddings')

const AI_SETTINGS_KEY = 'ai.enabled'
const MIN_CONTENT_LENGTH = 10

function emitProgress(current: number, total: number, phase: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(SettingsChannels.events.EMBEDDING_PROGRESS, {
      current,
      total,
      phase
    })
  })
}

function isAIEnabled(): boolean {
  try {
    const db = getDatabase()
    const enabled = getSetting(db, AI_SETTINGS_KEY)
    return enabled !== 'false'
  } catch {
    return false
  }
}

function storeNoteEmbedding(noteId: string, embedding: Float32Array): void {
  const rawDb = getRawIndexDatabase()
  rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)
  rawDb.prepare('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)').run(noteId, embedding)
}

function deleteNoteEmbedding(noteId: string): void {
  try {
    const rawDb = getRawIndexDatabase()
    rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)
  } catch {
    // ignore missing vec table during shutdown/setup
  }
}

async function updateEmbedding(noteId: string, content: string): Promise<boolean> {
  if (!isAIEnabled() || content.length < MIN_CONTENT_LENGTH) {
    deleteNoteEmbedding(noteId)
    return false
  }

  if (!isModelLoaded()) {
    const loaded = await initEmbeddingModel()
    if (!loaded) {
      return false
    }
  }

  const embedding = await generateLocalEmbedding(content)
  if (!embedding) {
    return false
  }

  storeNoteEmbedding(noteId, embedding)
  return true
}

export function createEmbeddingProjector(getVaultPath: () => string | null): ProjectionProjector {
  return {
    name: 'embedding',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNoteEmbedding(event.noteId)
        return
      }

      if (event.type !== 'note.upserted') {
        return
      }

      const note = event.note

      if (note.kind !== 'markdown') {
        deleteNoteEmbedding(note.noteId)
        return
      }

      await updateEmbedding(note.noteId, note.parsedContent)
    },

    async rebuild(): Promise<{
      success: boolean
      computed: number
      skipped: number
      error?: string
    }> {
      if (!isAIEnabled()) {
        return { success: false, computed: 0, skipped: 0, error: 'AI is disabled' }
      }

      const vaultPath = getVaultPath()
      if (!vaultPath) {
        return { success: false, computed: 0, skipped: 0, error: 'No vault is open' }
      }

      if (!isModelLoaded()) {
        const loaded = await initEmbeddingModel()
        if (!loaded) {
          return {
            success: false,
            computed: 0,
            skipped: 0,
            error: 'Failed to load embedding model'
          }
        }
      }

      const indexDb = getIndexDatabase()
      const rawDb = getRawIndexDatabase()
      const notes = indexDb.all<{ id: string; path: string; fileType: string | null }>(sql`
        SELECT id, path, file_type as fileType
        FROM note_cache
        WHERE COALESCE(file_type, 'markdown') = 'markdown'
      `)

      rawDb.prepare('DELETE FROM vec_notes').run()
      emitProgress(0, notes.length, 'embedding')

      let computed = 0
      let skipped = 0

      for (let i = 0; i < notes.length; i++) {
        const note = notes[i]
        try {
          const absolutePath = path.join(vaultPath, note.path)
          const raw = await fs.readFile(absolutePath, 'utf-8')
          const parsed = parseNote(raw, note.path)

          if (!(await updateEmbedding(note.id, parsed.content))) {
            skipped++
          } else {
            computed++
          }
        } catch (error) {
          skipped++
          logger.warn('Failed to rebuild note embedding', { noteId: note.id, error })
        }

        if ((i + 1) % 5 === 0 || i === notes.length - 1) {
          emitProgress(i + 1, notes.length, 'embedding')
        }
      }

      emitProgress(notes.length, notes.length, 'complete')
      return { success: true, computed, skipped }
    },

    async reconcile(): Promise<void> {
      const rawDb = getRawIndexDatabase()
      const indexDb = getIndexDatabase()

      rawDb
        .prepare(
          `
          DELETE FROM vec_notes
          WHERE note_id NOT IN (
            SELECT id
            FROM note_cache
            WHERE COALESCE(file_type, 'markdown') = 'markdown'
          )
          `
        )
        .run()

      const existingNoteIds = indexDb.all<{ id: string }>(sql`
        SELECT id
        FROM note_cache
        WHERE COALESCE(file_type, 'markdown') = 'markdown'
      `)

      emitProgress(existingNoteIds.length, existingNoteIds.length, 'complete')
    }
  }
}
