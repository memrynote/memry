import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { noteEmbeddingState } from '@memry/db-schema/schema/note-embedding-state'
import { extractedText } from '@memry/db-schema/schema/extracted-text'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import {
  closeAllDatabases,
  getDatabase,
  getIndexDatabase,
  getRawIndexDatabase,
  initDatabase,
  initIndexDatabase,
  runIndexMigrations,
  runMigrations
} from '../../database'
import type * as DatabaseModule from '../../database'
import { setSetting } from '../../database/queries/settings'
import { EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'
import { EMBEDDING_DIMENSION } from '../../lib/embeddings-constants'
import { createProjectionRuntime } from '../runtime'
import type { MarkdownNoteProjection, ProjectionEvent } from '../types'
import { createEmbeddingProjector } from './embedding-projector'

const databaseAvailability = vi.hoisted(() => ({ available: true }))
vi.mock('../../database', async (importOriginal) => {
  const actual = await importOriginal<typeof DatabaseModule>()
  return {
    ...actual,
    getRawIndexDatabase: () => {
      if (!databaseAvailability.available) throw new Error('Index database not initialized')
      return actual.getRawIndexDatabase()
    }
  }
})

const inference = vi.hoisted(() => ({
  generate: vi.fn<(text: string) => Promise<Float32Array | null>>(),
  send: vi.fn<(channel: string, progress: unknown) => void>()
}))
vi.mock('../../lib/embeddings', () => ({
  generateEmbedding: inference.generate,
  initEmbeddingModel: async () => true,
  isModelLoaded: () => true
}))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: inference.send }
      }
    ]
  }
}))

const NOW = '2026-01-01T00:00:00.000Z'
const OLD_BODY = 'The original expedition followed the glacier. '.repeat(220)
const NEW_BODY = 'The latest expedition follows the coast and the marsh.'

function vector(axis: number): Float32Array {
  const result = new Float32Array(EMBEDDING_DIMENSION)
  result[axis] = 1
  return result
}

describe('embedding projector durable recovery (real SQLite and vault files)', () => {
  let vault: string
  let indexing: boolean

  const openDatabases = (): void => {
    const dataPath = path.join(vault, 'data.db')
    const indexPath = path.join(vault, 'index.db')
    runMigrations(dataPath)
    runIndexMigrations(indexPath)
    initDatabase(dataPath)
    initIndexDatabase(indexPath)
  }

  const projector = () =>
    createEmbeddingProjector(
      () => vault,
      () => indexing
    )
  const state = () => getIndexDatabase().select().from(noteEmbeddingState).get()
  const vectors = () => {
    const db = getRawIndexDatabase()
    return {
      head: db
        .prepare('SELECT note_id, hex(embedding) AS embedding FROM vec_notes ORDER BY note_id')
        .all(),
      similar: db
        .prepare(
          'SELECT note_id, hex(embedding) AS embedding FROM vec_note_similar ORDER BY note_id'
        )
        .all(),
      chunks: db
        .prepare(
          'SELECT chunk_id, hex(embedding) AS embedding FROM vec_note_chunks ORDER BY chunk_id'
        )
        .all()
    }
  }
  const headVector = () =>
    getRawIndexDatabase()
      .prepare<[], { embedding: string }>('SELECT hex(embedding) AS embedding FROM vec_notes')
      .get()?.embedding

  const upsert = (content: string | null): ProjectionEvent => {
    if (content !== null) writeFileSync(path.join(vault, 'note.md'), content)
    return {
      type: 'note.upserted',
      note: {
        kind: 'markdown',
        noteId: 'note',
        path: 'note.md',
        title: 'Recovery',
        fileType: 'markdown',
        localOnly: false,
        contentHash: null,
        wordCount: null,
        characterCount: null,
        snippet: null,
        date: null,
        emoji: null,
        createdAt: NOW,
        modifiedAt: NOW,
        parsedContent: content,
        tags: [],
        headerTags: [],
        properties: {},
        aliases: [],
        wikiLinks: []
      } satisfies MarkdownNoteProjection
    }
  }

  const completions = () =>
    inference.send.mock.calls.filter(
      ([channel, progress]) =>
        channel === SettingsChannels.events.EMBEDDING_PROGRESS &&
        typeof progress === 'object' &&
        progress !== null &&
        'phase' in progress &&
        progress.phase === 'complete'
    ).length

  beforeEach(() => {
    databaseAvailability.available = true
    vault = mkdtempSync(path.join(tmpdir(), 'memry-embedding-recovery-'))
    indexing = false
    openDatabases()
    getIndexDatabase()
      .insert(noteCache)
      .values({
        id: 'note',
        path: 'note.md',
        title: 'Recovery',
        fileType: 'markdown',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
    setSetting(getDatabase(), 'ai.enabled', 'true')
    inference.generate.mockReset().mockResolvedValue(vector(0))
    inference.send.mockClear()
  })

  afterEach(() => {
    closeAllDatabases()
    rmSync(vault, { recursive: true, force: true })
  })

  it('indexes when constructed before the index database opens, then continues handling live edits', async () => {
    closeAllDatabases()
    databaseAvailability.available = false
    const current = projector()
    await current.reconcile()

    databaseAvailability.available = true
    openDatabases()
    writeFileSync(path.join(vault, 'note.md'), NEW_BODY)
    await current.reconcile()

    expect(state()).toEqual({
      noteId: 'note',
      inputVersion: EMBEDDING_INPUT_VERSION,
      chunkCount: 0
    })
    expect(headVector()).toBe(Buffer.from(vector(0).buffer).toString('hex').toUpperCase())
    expect(inference.generate).toHaveBeenCalledTimes(2)

    inference.generate.mockResolvedValue(vector(1))
    await current.project(upsert('A newer live edit after the vault has finished opening.'))
    expect(headVector()).toBe(Buffer.from(vector(1).buffer).toString('hex').toUpperCase())
    expect(state()?.inputVersion).toBe(EMBEDDING_INPUT_VERSION)
  })

  it('preserves old vectors and chunk ownership through a disabled edit and recovers after reopening SQLite', async () => {
    const current = projector()
    await current.project(upsert(OLD_BODY))
    const oldVectors = vectors()
    const oldState = state()
    expect(oldState?.chunkCount).toBeGreaterThan(0)

    // Tier-0 metadata is not an embeddable edit and must not create debt.
    indexing = true
    await current.project(upsert(null))
    expect(state()).toEqual(oldState)
    indexing = false

    setSetting(getDatabase(), 'ai.enabled', 'false')
    inference.generate.mockClear()
    await current.project(upsert(NEW_BODY))
    const disabled = {
      vectors: vectors(),
      state: state(),
      calls: inference.generate.mock.calls.length
    }

    closeAllDatabases()
    openDatabases()
    setSetting(getDatabase(), 'ai.enabled', 'true')
    inference.generate.mockResolvedValue(vector(1))
    await projector().reconcile()

    expect(disabled).toEqual({
      vectors: oldVectors,
      state: { ...oldState, inputVersion: 0 },
      calls: 0
    })
    expect(state()).toEqual({
      noteId: 'note',
      inputVersion: EMBEDDING_INPUT_VERSION,
      chunkCount: 0
    })
    expect(headVector()).toBe(Buffer.from(vector(1).buffer).toString('hex').toUpperCase())
    expect(vectors().chunks).toEqual([])
  })

  it('persists a failed live edit as owed work across a projector and SQLite restart', async () => {
    const current = projector()
    await current.project(upsert(OLD_BODY))
    const oldVectors = vectors()
    const oldState = state()
    inference.generate.mockResolvedValueOnce(null)
    await current.project(upsert(NEW_BODY))
    const failed = { state: state(), vectors: vectors() }

    closeAllDatabases()
    openDatabases()
    inference.generate.mockResolvedValue(vector(1))
    await projector().reconcile()

    expect(failed).toEqual({ state: { ...oldState, inputVersion: 0 }, vectors: oldVectors })
    expect(state()).toEqual({
      noteId: 'note',
      inputVersion: EMBEDDING_INPUT_VERSION,
      chunkCount: 0
    })
    expect(headVector()).toBe(Buffer.from(vector(1).buffer).toString('hex').toUpperCase())
  })

  it('does not let a stopped vault A rebuild overwrite vault B after its inference returns', async () => {
    const vaultA = vault
    const original = createEmbeddingProjector(() => vaultA)
    await original.project(upsert(OLD_BODY))
    const runtime = createProjectionRuntime({ projectors: [original] })
    const started = Promise.withResolvers<void>()
    const computed = Promise.withResolvers<Float32Array>()
    inference.generate.mockImplementationOnce(() => {
      started.resolve()
      return computed.promise
    })

    const rebuilding = runtime.rebuild(['embedding'])
    await started.promise
    try {
      // Runtime stop currently does not await manual rebuilds. A's in-flight
      // inference can therefore return after the next vault owns the globals.
      await runtime.stop({ drain: false })
      closeAllDatabases()
      vault = path.join(vaultA, 'vault-b')
      mkdirSync(vault)
      openDatabases()
      getIndexDatabase()
        .insert(noteCache)
        .values({
          id: 'note', // Shared ids are normal on two devices' copies of a vault.
          path: 'note.md',
          title: 'Recovery',
          fileType: 'markdown',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      setSetting(getDatabase(), 'ai.enabled', 'true')
      inference.generate.mockResolvedValue(vector(2))
      await projector().project(upsert(NEW_BODY))
      const before = { state: state(), vectors: vectors() }

      inference.generate.mockResolvedValue(vector(1))
      computed.resolve(vector(1))
      await rebuilding

      expect({ state: state(), vectors: vectors() }).toEqual(before)
    } finally {
      computed.resolve(vector(1))
      await rebuilding
      vault = vaultA
    }
  })

  it('retries a failed deferred note instead of clearing its debt or reporting completion', async () => {
    const current = projector()
    await current.project(upsert(OLD_BODY))
    const oldVectors = vectors()
    indexing = true
    await current.project(upsert(NEW_BODY))
    indexing = false
    inference.generate.mockResolvedValueOnce(null)
    inference.send.mockClear()
    await current.reconcile()
    const failed = {
      version: state()?.inputVersion,
      vectors: vectors(),
      completions: completions()
    }

    inference.generate.mockResolvedValue(vector(1))
    await current.reconcile()

    expect(failed).toEqual({ version: 0, vectors: oldVectors, completions: 0 })
    expect(headVector()).toBe(Buffer.from(vector(1).buffer).toString('hex').toUpperCase())
    expect(state()?.inputVersion).toBe(EMBEDDING_INPUT_VERSION)
  })

  it.each(['deferred', 'failed', 'successful'] as const)(
    'does not let an older reconcile overwrite or clear a newer %s edit',
    async (newerOutcome) => {
      const current = projector()
      await current.project(upsert(OLD_BODY))
      let newerVectors = vectors()
      indexing = true
      await current.project(upsert('An older reading of the expedition log.'))
      indexing = false
      const started = Promise.withResolvers<void>()
      const computed = Promise.withResolvers<Float32Array>()
      inference.generate.mockImplementation(async (text: string) =>
        text.includes('latest') ? vector(2) : vector(1)
      )
      inference.generate.mockImplementationOnce(() => {
        started.resolve()
        return computed.promise
      })
      const reconciling = current.reconcile()
      await started.promise

      try {
        indexing = newerOutcome === 'deferred'
        if (newerOutcome === 'failed') inference.generate.mockResolvedValueOnce(null)
        await current.project(upsert(NEW_BODY))
        newerVectors = vectors()
      } finally {
        indexing = false
        computed.resolve(vector(1))
        await reconciling
      }

      const expectedAxis = newerOutcome === 'successful' ? 2 : 0
      const expectedVersion = newerOutcome === 'successful' ? EMBEDDING_INPUT_VERSION : 0
      expect(vectors()).toEqual(newerVectors)
      expect(headVector()).toBe(
        Buffer.from(vector(expectedAxis).buffer).toString('hex').toUpperCase()
      )
      expect(state()?.inputVersion).toBe(expectedVersion)

      await current.reconcile()
      expect(headVector()).toBe(Buffer.from(vector(2).buffer).toString('hex').toUpperCase())
      expect(state()?.inputVersion).toBe(EMBEDDING_INPUT_VERSION)
    }
  )

  it.each(['disabled', 'aborted'] as const)(
    'stops between chunks when %s without replacing valid vectors or announcing completion',
    async (reason) => {
      const current = projector()
      await current.project(upsert(OLD_BODY))
      const oldVectors = vectors()
      const oldState = state()
      indexing = true
      await current.project(upsert(`${NEW_BODY}\n${OLD_BODY}`))
      indexing = false
      const controller = new AbortController()
      inference.generate.mockClear().mockImplementationOnce(async () => {
        if (reason === 'aborted') controller.abort()
        else setSetting(getDatabase(), 'ai.enabled', 'false')
        return vector(1)
      })
      inference.send.mockClear()

      await current.reconcile(controller.signal)

      expect({
        calls: inference.generate.mock.calls.length,
        vectors: vectors(),
        state: state(),
        completions: completions()
      }).toEqual({
        calls: 1,
        vectors: oldVectors,
        state: { ...oldState, inputVersion: 0 },
        completions: 0
      })
    }
  )

  it.each(['markdown', 'pdf'] as const)(
    'recovers failed %s extracted-text events after reopening SQLite',
    async (fileType) => {
      if (fileType === 'pdf') {
        getRawIndexDatabase()
          .prepare("UPDATE note_cache SET file_type = 'pdf' WHERE id = 'note'")
          .run()
      }
      getIndexDatabase()
        .insert(extractedText)
        .values({ noteId: 'note', source: '', part: 0, method: 'ocr', text: OLD_BODY })
        .run()
      writeFileSync(path.join(vault, 'note.md'), 'An expedition log with attached readings.')
      const current = projector()
      await current.project({ type: 'note.text-extracted', noteId: 'note' })
      const oldVectors = vectors()
      const oldState = state()
      getRawIndexDatabase().prepare('UPDATE extracted_text SET text = ?').run(NEW_BODY)
      inference.generate.mockResolvedValueOnce(null)

      await current.project({ type: 'note.text-extracted', noteId: 'note' })
      const failed = { state: state(), vectors: vectors() }
      closeAllDatabases()
      openDatabases()
      inference.generate.mockResolvedValue(vector(1))
      await projector().reconcile()

      expect(failed).toEqual({ state: { ...oldState, inputVersion: 0 }, vectors: oldVectors })
      expect(headVector()).toBe(Buffer.from(vector(1).buffer).toString('hex').toUpperCase())
      expect(state()?.inputVersion).toBe(EMBEDDING_INPUT_VERSION)
    }
  )
})
