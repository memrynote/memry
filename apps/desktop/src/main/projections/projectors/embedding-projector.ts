import fs from 'fs/promises'
import path from 'path'
import { sql } from 'drizzle-orm'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../../database'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { parseNote } from '../../vault/frontmatter'
import {
  generateEmbedding as generateLocalEmbedding,
  initEmbeddingModel,
  isModelLoaded
} from '../../lib/embeddings'
import { buildEmbeddingInput, EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:Embeddings')

const AI_SETTINGS_KEY = 'ai.enabled'
const EMBEDDING_VERSION_KEY = 'ai.embeddingInputVersion'
const MIN_CONTENT_LENGTH = 10

function emitProgress(current: number, total: number, phase: string): void {
  broadcastToAllWindows(SettingsChannels.events.EMBEDDING_PROGRESS, {
    current,
    total,
    phase
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

export function createEmbeddingProjector(
  getVaultPath: () => string | null,
  isIndexing: () => boolean = () => false
): ProjectionProjector {
  // Note ids whose embedding was deferred because it arrived during the initial
  // index pass (see project()). Instance-scoped so it starts empty per open; the
  // backgrounded reconcile drains it after the vault is open (#803).
  const pendingEmbedding = new Set<string>()

  // Embed a list of markdown notes from disk. Shared by the full rebuild and the
  // reconcile backfill; assumes the model is already loaded and vaultPath is set.
  const embedNotes = async (
    vaultPath: string,
    notes: Array<{ id: string; path: string; title: string | null }>
  ): Promise<{ computed: number; skipped: number }> => {
    let computed = 0
    let skipped = 0

    for (let i = 0; i < notes.length; i++) {
      const note = notes[i]
      try {
        const absolutePath = path.join(vaultPath, note.path)
        const raw = await fs.readFile(absolutePath, 'utf-8')
        const parsed = parseNote(raw, note.path)

        const input = buildEmbeddingInput({ title: note.title, content: parsed.content })
        if (!(await updateEmbedding(note.id, input))) {
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

    return { computed, skipped }
  }

  const runRebuild = async (): Promise<{
    success: boolean
    computed: number
    skipped: number
    error?: string
  }> => {
    if (!isAIEnabled()) {
      return { success: false, computed: 0, skipped: 0, error: 'AI is disabled' }
    }

    const vaultPath = getVaultPath()
    if (!vaultPath) {
      return { success: false, computed: 0, skipped: 0, error: 'No vault is open' }
    }

    // Query the work list BEFORE loading the model. initEmbeddingModel() loads a
    // heavy native model (seconds), so an empty/markdown-less vault must not pay
    // that cost just to find nothing to embed — which is exactly the fresh-vault
    // case on every app open until the first note exists (and every E2E launch).
    const indexDb = getIndexDatabase()
    const rawDb = getRawIndexDatabase()
    const notes = indexDb.all<{
      id: string
      path: string
      title: string | null
      fileType: string | null
    }>(sql`
      SELECT id, path, title, file_type as fileType
      FROM note_cache
      WHERE COALESCE(file_type, 'markdown') = 'markdown'
    `)

    if (notes.length === 0) {
      rawDb.prepare('DELETE FROM vec_notes').run()
      emitProgress(0, 0, 'complete')
      return { success: true, computed: 0, skipped: 0 }
    }

    if (!isModelLoaded()) {
      const loaded = await initEmbeddingModel()
      if (!loaded) {
        return { success: false, computed: 0, skipped: 0, error: 'Failed to load embedding model' }
      }
    }

    rawDb.prepare('DELETE FROM vec_notes').run()
    emitProgress(0, notes.length, 'embedding')

    const { computed, skipped } = await embedNotes(vaultPath, notes)

    emitProgress(notes.length, notes.length, 'complete')
    return { success: true, computed, skipped }
  }

  return {
    name: 'embedding',

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNoteEmbedding(event.noteId)
        pendingEmbedding.delete(event.noteId)
        return
      }

      if (event.type !== 'note.upserted') {
        return
      }

      const note = event.note

      if (note.kind !== 'markdown') {
        deleteNoteEmbedding(note.noteId)
        pendingEmbedding.delete(note.noteId)
        return
      }

      // During the initial index pass, embedding is deferred: indexVault awaits
      // this projector per file (before the vault is marked open), and loading the
      // ~23MB model + running CPU inference here is what stranded vault-open for
      // minutes. Record the id and let the backgrounded reconcile embed it after
      // isOpen. Only fires while isIndexing; live edits still embed inline. (#803)
      if (isIndexing()) {
        pendingEmbedding.add(note.noteId)
        return
      }

      await updateEmbedding(
        note.noteId,
        buildEmbeddingInput({ title: note.title, content: note.parsedContent })
      )
    },

    rebuild: runRebuild,

    async reconcile(): Promise<void> {
      // One-time rebuild when the embedding input formula changed, so stored
      // vectors don't silently mix old and new shapes (Codex #11).
      try {
        const db = getDatabase()
        const stored = getSetting(db, EMBEDDING_VERSION_KEY)
        if (isAIEnabled() && stored !== String(EMBEDDING_INPUT_VERSION)) {
          logger.info('Embedding input version changed — rebuilding embeddings', {
            from: stored,
            to: EMBEDDING_INPUT_VERSION
          })
          const result = await runRebuild()
          if (result.success) {
            setSetting(db, EMBEDDING_VERSION_KEY, String(EMBEDDING_INPUT_VERSION))
            return
          }
        }
      } catch (error) {
        logger.warn('Embedding version check failed', { error })
      }

      const rawDb = getRawIndexDatabase()
      const indexDb = getIndexDatabase()

      // Prune vectors for notes that no longer exist.
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

      const markdownNotes = indexDb.all<{
        id: string
        path: string
        title: string | null
      }>(sql`
        SELECT id, path, title
        FROM note_cache
        WHERE COALESCE(file_type, 'markdown') = 'markdown'
      `)

      const vaultPath = getVaultPath()
      if (!isAIEnabled() || !vaultPath) {
        // Deferred ids are left intact — nothing was embedded, so a later
        // reconcile (or a full rebuild once AI is enabled) can still pick them up.
        emitProgress(markdownNotes.length, markdownNotes.length, 'complete')
        return
      }

      // Backfill: embed markdown notes with no vector yet (freshly imported notes
      // whose inline embedding was deferred during indexing) plus any deferred /
      // edited notes tracked this session. Runs in the background after isOpen, so
      // a slow or failed model load never blocks vault-open (#803). Loading the
      // model is bounded to when there is actually work to do.
      const embeddedIds = new Set(
        (rawDb.prepare('SELECT note_id FROM vec_notes').all() as Array<{ note_id: string }>).map(
          (row) => row.note_id
        )
      )
      const workList = markdownNotes.filter(
        (note) => !embeddedIds.has(note.id) || pendingEmbedding.has(note.id)
      )

      if (workList.length === 0) {
        pendingEmbedding.clear()
        emitProgress(markdownNotes.length, markdownNotes.length, 'complete')
        return
      }

      if (!isModelLoaded()) {
        const loaded = await initEmbeddingModel()
        if (!loaded) {
          // Keep the deferred ids: dropping them here would let an edited note
          // (which still has a stale vector, so the missing-vector filter above
          // won't re-catch it) keep that stale embedding after a failed load.
          emitProgress(markdownNotes.length, markdownNotes.length, 'complete')
          return
        }
      }

      emitProgress(0, workList.length, 'embedding')
      await embedNotes(vaultPath, workList)
      pendingEmbedding.clear()
      emitProgress(workList.length, workList.length, 'complete')
    }
  }
}
