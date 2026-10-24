import { sql } from 'drizzle-orm'
import type Database from 'better-sqlite3'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../../database'
import { getSetting } from '@main/database/queries/settings'
import { getNoteCacheById } from '@main/database/queries/notes'
import { readExtractedOpening } from '@main/database/queries/extracted-text'
import { parseNote } from '../../vault/frontmatter'
import {
  generateEmbedding as generateLocalEmbedding,
  initEmbeddingModel,
  isModelLoaded
} from '../../lib/embeddings'
import {
  buildEmbeddingChunks,
  buildEmbeddingInput,
  EMBEDDING_INPUT_VERSION,
  MAX_EMBEDDABLE_CONTENT_LENGTH
} from '../../lib/embedding-input'
import { createLogger } from '../../lib/logger'
import { readVaultFile } from '../../lib/paths'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:Embeddings')

const AI_SETTINGS_KEY = 'ai.enabled'

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

/** Drop the rows a note owns in vec_note_chunks, as recorded by its state row. */
function deleteNoteChunks(rawDb: Database.Database, noteId: string): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 returns unknown rows; row shape is fixed by this SQL
  const state = rawDb
    .prepare('SELECT chunk_count FROM note_embedding_state WHERE note_id = ?')
    .get(noteId) as { chunk_count: number } | undefined
  const remove = rawDb.prepare('DELETE FROM vec_note_chunks WHERE chunk_id = ?')
  for (let index = 1; index <= (state?.chunk_count ?? 0); index++) {
    remove.run(`${noteId}#${index}`)
  }
}

/**
 * Write a note's vectors: the head window to vec_notes and every later window
 * to vec_note_chunks (both read by search), and the `similarity` vector to
 * vec_note_similar (read by related notes, tags, grouping and filing), in one
 * transaction so a crash never leaves a state row that disagrees with them.
 */
function storeNoteEmbeddings(
  noteId: string,
  embeddings: Float32Array[],
  similar: Float32Array
): void {
  const rawDb = getRawIndexDatabase()
  const [head, ...later] = embeddings
  rawDb.transaction(() => {
    deleteNoteChunks(rawDb, noteId)
    rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)
    rawDb.prepare('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)').run(noteId, head)
    rawDb.prepare('DELETE FROM vec_note_similar WHERE note_id = ?').run(noteId)
    rawDb
      .prepare('INSERT INTO vec_note_similar (note_id, embedding) VALUES (?, ?)')
      .run(noteId, similar)
    later.forEach((embedding, index) => {
      rawDb
        .prepare('INSERT INTO vec_note_chunks (chunk_id, embedding) VALUES (?, ?)')
        .run(`${noteId}#${index + 1}`, embedding)
    })
    rawDb
      .prepare(
        'INSERT OR REPLACE INTO note_embedding_state (note_id, input_version, chunk_count) VALUES (?, ?, ?)'
      )
      .run(noteId, EMBEDDING_INPUT_VERSION, later.length)
  })()
}

function deleteNoteEmbedding(noteId: string): void {
  try {
    const rawDb = getRawIndexDatabase()
    rawDb.transaction(() => {
      deleteNoteChunks(rawDb, noteId)
      rawDb.prepare('DELETE FROM vec_notes WHERE note_id = ?').run(noteId)
      rawDb.prepare('DELETE FROM vec_note_similar WHERE note_id = ?').run(noteId)
      rawDb.prepare('DELETE FROM note_embedding_state WHERE note_id = ?').run(noteId)
    })()
  } catch {
    // ignore missing vec table during shutdown/setup
  }
}

interface EmbeddableNote {
  id: string
  path: string
  title: string | null
  fileType: string | null
}

/**
 * Markdown notes, plus filed PDFs and images once text has been read out of
 * them. A file's vector comes from its extracted text, never from its bytes.
 */
const EMBEDDABLE_NOTES = sql`
  SELECT id, path, title, file_type as fileType
  FROM note_cache
  WHERE COALESCE(file_type, 'markdown') = 'markdown'
    OR id IN (SELECT note_id FROM extracted_text WHERE text != '')
`

/** A file's extracted text, up to the most the embedding input ever reads. */
function readFileTextOpening(noteId: string): string {
  return readExtractedOpening(getIndexDatabase(), noteId, MAX_EMBEDDABLE_CONTENT_LENGTH)
}

/**
 * A markdown note's body, then the opening of the text read from its
 * attachments, so a note that is mostly a pasted screenshot still has a vector.
 */
function withAttachmentText(noteId: string, content: string): string {
  const room = MAX_EMBEDDABLE_CONTENT_LENGTH - content.length
  if (room <= 0) return content
  const extracted = readExtractedOpening(getIndexDatabase(), noteId, room)
  return extracted ? `${content}\n\n${extracted}` : content
}

async function readEmbeddableContent(vaultPath: string, note: EmbeddableNote): Promise<string> {
  if (note.fileType && note.fileType !== 'markdown') {
    return readFileTextOpening(note.id)
  }
  const raw = await readVaultFile(vaultPath, note.path)
  if (raw === null) throw new Error(`Note file is missing: ${note.path}`)
  return withAttachmentText(note.id, parseNote(raw, note.path).content)
}

interface NoteText {
  title?: string | null
  content: string
}

async function updateEmbedding(noteId: string, text: NoteText): Promise<boolean> {
  const windows = buildEmbeddingChunks(text)
  if (!isAIEnabled() || windows.length === 0) {
    deleteNoteEmbedding(noteId)
    return false
  }

  if (!isModelLoaded()) {
    const loaded = await initEmbeddingModel()
    if (!loaded) {
      return false
    }
  }

  // One window at a time: peak memory is one inference, however long the note.
  const embeddings: Float32Array[] = []
  for (const window of windows) {
    const embedding = await generateLocalEmbedding(window)
    if (!embedding) {
      return false
    }
    embeddings.push(embedding)
  }
  const similar = await generateLocalEmbedding(buildEmbeddingInput(text, 'similarity'))
  if (!similar) {
    return false
  }

  storeNoteEmbeddings(noteId, embeddings, similar)
  return true
}

// Embed a list of notes: markdown from disk, filed PDFs and images from their
// extracted text. Shared by the full rebuild and the reconcile backfill;
// assumes the model is already loaded and vaultPath is set.
const embedNotes = async (
  vaultPath: string,
  notes: EmbeddableNote[],
  signal?: AbortSignal
): Promise<{ computed: number; skipped: number }> => {
  let computed = 0
  let skipped = 0

  for (let i = 0; i < notes.length; i++) {
    // Checked per note, not per pass: this loop is the long pole (file read +
    // CPU inference each), so a close or vault switch has to be able to cut it
    // short between notes instead of after the whole work list.
    if (signal?.aborted) {
      break
    }

    const note = notes[i]
    try {
      const content = await readEmbeddableContent(vaultPath, note)
      if (!(await updateEmbedding(note.id, { title: note.title, content }))) {
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

export function createEmbeddingProjector(
  getVaultPath: () => string | null,
  isIndexing: () => boolean = () => false
): ProjectionProjector {
  // Note ids whose embedding was deferred because it arrived during the initial
  // index pass (see project()). Instance-scoped so it starts empty per open; the
  // backgrounded reconcile drains it after the vault is open (#803).
  const pendingEmbedding = new Set<string>()

  const runRebuild = async (
    signal?: AbortSignal
  ): Promise<{
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
    const notes = indexDb.all<EmbeddableNote>(EMBEDDABLE_NOTES)

    if (notes.length === 0) {
      rawDb.prepare('DELETE FROM vec_notes').run()
      rawDb.prepare('DELETE FROM vec_note_chunks').run()
      rawDb.prepare('DELETE FROM vec_note_similar').run()
      rawDb.prepare('DELETE FROM note_embedding_state').run()
      emitProgress(0, 0, 'complete')
      return { success: true, computed: 0, skipped: 0 }
    }

    if (!isModelLoaded()) {
      const loaded = await initEmbeddingModel()
      if (!loaded) {
        return { success: false, computed: 0, skipped: 0, error: 'Failed to load embedding model' }
      }
    }

    // The load above takes seconds; re-check before the destructive DELETE so an
    // aborted pass does not wipe the vector table it is no longer going to refill.
    if (signal?.aborted) {
      return { success: false, computed: 0, skipped: 0, error: 'Aborted' }
    }

    rawDb.prepare('DELETE FROM vec_notes').run()
    rawDb.prepare('DELETE FROM vec_note_chunks').run()
    rawDb.prepare('DELETE FROM vec_note_similar').run()
    rawDb.prepare('DELETE FROM note_embedding_state').run()
    emitProgress(0, notes.length, 'embedding')

    const { computed, skipped } = await embedNotes(vaultPath, notes, signal)

    if (signal?.aborted) {
      return { success: false, computed, skipped, error: 'Aborted' }
    }

    emitProgress(notes.length, notes.length, 'complete')
    return { success: true, computed, skipped }
  }

  const embedFileText = async (noteId: string, title: string): Promise<void> => {
    const content = readFileTextOpening(noteId)
    if (!content) {
      deleteNoteEmbedding(noteId)
      pendingEmbedding.delete(noteId)
      return
    }
    if (isIndexing()) {
      pendingEmbedding.add(noteId)
      return
    }
    await updateEmbedding(noteId, { title, content })
  }

  return {
    name: 'embedding',

    // Nothing reads embeddings back in the same turn, and project() below can
    // await a model load plus CPU inference — so callers of
    // flushProjectionEvents() must not queue behind this lane (#1078).
    background: true,

    handles(event: ProjectionEvent): boolean {
      return (
        event.type === 'note.upserted' ||
        event.type === 'note.deleted' ||
        event.type === 'note.text-extracted'
      )
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNoteEmbedding(event.noteId)
        pendingEmbedding.delete(event.noteId)
        return
      }

      if (event.type === 'note.text-extracted') {
        const note = getNoteCacheById(getIndexDatabase(), event.noteId)
        if (!note) return
        if (note.fileType !== 'markdown') {
          await embedFileText(note.id, note.title)
          return
        }
        // Text read from the note's attachments changed.
        const vaultPath = getVaultPath()
        if (isIndexing()) {
          pendingEmbedding.add(note.id)
        } else if (vaultPath) {
          try {
            const content = await readEmbeddableContent(vaultPath, note)
            await updateEmbedding(note.id, { title: note.title, content })
          } catch (error) {
            logger.warn('Failed to embed attachment text', { noteId: note.id, error })
          }
        }
        return
      }

      if (event.type !== 'note.upserted') {
        return
      }

      const note = event.note

      if (note.kind !== 'markdown') {
        await embedFileText(note.noteId, note.title)
        return
      }

      // Body not read yet (tier 0 of ingest); the idle backfill republishes the
      // note with its body. Embedding the title alone would be worse than
      // waiting, and it would drop any embedding the note already has.
      if (note.parsedContent === null) {
        return
      }

      // During the initial index pass, embedding is deferred: indexVault awaits
      // this projector per file (before the vault is marked open), and loading the
      // ~210MB model + running CPU inference here is what stranded vault-open for
      // minutes. Record the id and let the backgrounded reconcile embed it after
      // isOpen. Only fires while isIndexing; live edits still embed inline. (#803)
      if (isIndexing()) {
        pendingEmbedding.add(note.noteId)
        return
      }

      await updateEmbedding(note.noteId, {
        title: note.title,
        content: withAttachmentText(note.noteId, note.parsedContent)
      })
    },

    rebuild: runRebuild,

    /**
     * `signal` aborts when the runtime stops — vault close, or a superseded
     * runtime on vault switch (#993, #1024). This pass was the one projector
     * that ignored it, and it is the expensive one: a ~210MB model load plus CPU
     * inference per note. Two consequences, both fixed by honouring it here:
     * `closeVault` awaits the aborted pass before closing the databases, so a
     * large backfill held vault close (and quit) open for minutes — the class of
     * stall #803/#805 were about; and a superseded runtime's pass is not awaited
     * at all, so it kept reading the OLD vault's files and writing them into
     * whatever `getRawIndexDatabase()` points at by then — the new vault's index.
     */
    async reconcile(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) {
        return
      }

      if (signal?.aborted) {
        return
      }

      const rawDb = getRawIndexDatabase()
      const indexDb = getIndexDatabase()

      // Prune vectors for notes that no longer exist, or no longer have text.
      rawDb
        .prepare(
          `
          DELETE FROM vec_notes
          WHERE note_id NOT IN (
            SELECT id
            FROM note_cache
            WHERE COALESCE(file_type, 'markdown') = 'markdown'
              OR id IN (SELECT note_id FROM extracted_text WHERE text != '')
          )
          `
        )
        .run()
      rawDb
        .prepare(
          'DELETE FROM vec_note_similar WHERE note_id NOT IN (SELECT note_id FROM vec_notes)'
        )
        .run()
      // Chunk rows go first: their ids are read from the state rows deleted next.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 returns unknown rows; row shape is fixed by this SQL
      const orphaned = rawDb
        .prepare(
          `SELECT note_id FROM note_embedding_state
           WHERE chunk_count > 0 AND note_id NOT IN (SELECT note_id FROM vec_notes)`
        )
        .all() as Array<{ note_id: string }>
      for (const { note_id } of orphaned) deleteNoteChunks(rawDb, note_id)
      rawDb
        .prepare(
          'DELETE FROM note_embedding_state WHERE note_id NOT IN (SELECT note_id FROM vec_notes)'
        )
        .run()

      const embeddableNotes = indexDb.all<EmbeddableNote>(EMBEDDABLE_NOTES)

      const vaultPath = getVaultPath()
      if (!isAIEnabled() || !vaultPath) {
        // Deferred ids are left intact — nothing was embedded, so a later
        // reconcile (or a full rebuild once AI is enabled) can still pick them up.
        emitProgress(embeddableNotes.length, embeddableNotes.length, 'complete')
        return
      }

      // Backfill: embed notes with no vector yet (freshly imported notes
      // whose inline embedding was deferred during indexing) plus any deferred /
      // edited notes tracked this session. Runs in the background after isOpen, so
      // a slow or failed model load never blocks vault-open (#803). Loading the
      // model is bounded to when there is actually work to do.
      const embeddedIds = new Set(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 returns unknown rows; row shape is fixed by this SQL
        (rawDb.prepare('SELECT note_id FROM vec_notes').all() as Array<{ note_id: string }>).map(
          (row) => row.note_id
        )
      )
      // A vector written under an older EMBEDDING_INPUT_VERSION (or before the
      // state table existed) keeps answering searches and similarity until its
      // note comes up here; nothing is deleted up front, so an input change
      // never leaves the table empty and a quit mid-pass resumes where it left.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 returns unknown rows; row shape is fixed by this SQL
      const currentRows = rawDb
        .prepare('SELECT note_id FROM note_embedding_state WHERE input_version = ?')
        .all(EMBEDDING_INPUT_VERSION) as Array<{ note_id: string }>
      const currentIds = new Set(currentRows.map((row) => row.note_id))
      const owed = embeddableNotes.filter(
        (note) =>
          !embeddedIds.has(note.id) || !currentIds.has(note.id) || pendingEmbedding.has(note.id)
      )
      // Notes with no vector at all first: they are invisible to semantic search.
      const workList = [
        ...owed.filter((note) => !embeddedIds.has(note.id)),
        ...owed.filter((note) => embeddedIds.has(note.id))
      ]

      if (workList.length === 0) {
        pendingEmbedding.clear()
        emitProgress(embeddableNotes.length, embeddableNotes.length, 'complete')
        return
      }

      if (!isModelLoaded()) {
        const loaded = await initEmbeddingModel()
        if (!loaded) {
          // Keep the deferred ids: dropping them here would let an edited note
          // (which still has a stale vector, so the missing-vector filter above
          // won't re-catch it) keep that stale embedding after a failed load.
          emitProgress(embeddableNotes.length, embeddableNotes.length, 'complete')
          return
        }
      }

      if (signal?.aborted) {
        return
      }

      emitProgress(0, workList.length, 'embedding')
      await embedNotes(vaultPath, workList, signal)

      if (signal?.aborted) {
        // Deferred ids stay: the pass stopped part-way, so the notes it never
        // reached still owe an embedding on the next reconcile.
        return
      }

      pendingEmbedding.clear()
      emitProgress(workList.length, workList.length, 'complete')
    }
  }
}
