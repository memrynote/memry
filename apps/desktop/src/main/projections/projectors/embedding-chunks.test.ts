import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

const mocks = vi.hoisted(() => ({
  raw: null as unknown,
  generateEmbedding: vi.fn()
}))

vi.mock('../../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({ all: () => [] }),
  getRawIndexDatabase: () => mocks.raw
}))
vi.mock('@main/database/queries/settings', () => ({ getSetting: () => 'true' }))
vi.mock('@main/database/queries/extracted-text', () => ({ readExtractedOpening: () => '' }))
vi.mock('@main/database/queries/notes', () => ({ getNoteCacheById: vi.fn() }))
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../../lib/embeddings', () => ({
  generateEmbedding: mocks.generateEmbedding,
  initEmbeddingModel: vi.fn(async () => true),
  isModelLoaded: () => true
}))

import { ensureVecNotesTable } from '../../database/client'
import { EMBEDDING_DIMENSION } from '../../lib/embeddings-constants'
import { EMBEDDING_INPUT_VERSION, MAX_EMBEDDING_INPUT_LENGTH } from '../../lib/embedding-input'
import { semanticNoteHits } from '../../search/semantic'
import { createEmbeddingProjector } from './embedding-projector'
import type { ProjectionEvent } from '../types'

/** One axis per topic: a window mentioning the topic points down that axis. */
const TOPICS = ['saffron', 'quarterly', 'glacier']
function embedText(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSION)
  TOPICS.forEach((topic, axis) => {
    if (text.toLowerCase().includes(topic)) v[axis] = 1
  })
  if (v.every((x) => x === 0)) v[EMBEDDING_DIMENSION - 1] = 1
  const norm = Math.hypot(...v)
  return v.map((x) => x / norm)
}

function upsert(noteId: string, content: string): ProjectionEvent {
  return {
    type: 'note.upserted',
    note: { noteId, kind: 'markdown', title: 'Notes', parsedContent: content }
  } as unknown as ProjectionEvent
}

const filler = (n: number) => 'The meeting covered routine updates and nothing else. '.repeat(n)

describe('embedding chunks (real sqlite-vec)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    sqliteVec.load(db)
    ensureVecNotesTable(db)
    db.exec(
      'CREATE TABLE note_embedding_state (note_id TEXT PRIMARY KEY, input_version INTEGER NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0)'
    )
    mocks.raw = db
    mocks.generateEmbedding.mockImplementation(async (text: string) => embedText(text))
  })

  afterEach(() => db.close())

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  it('finds a fact placed at the end of a long note, which the head window never saw', async () => {
    const projector = createEmbeddingProjector(() => '/vault')
    const long = `${filler(300)}\n\nThe saffron order ships on Tuesday.`
    expect(long.length).toBeGreaterThan(MAX_EMBEDDING_INPUT_LENGTH * 3)
    await projector.project(upsert('long-note', long))
    await projector.project(upsert('other-note', `A short note about glacier travel plans.`))

    // The head vector alone is blind to the tail.
    const head = db.prepare('SELECT embedding FROM vec_notes WHERE note_id = ?').get('long-note')
    expect(head).toBeDefined()
    expect(count('vec_note_chunks')).toBeGreaterThan(0)

    const hits = await semanticNoteHits('saffron')
    expect(hits.map((hit) => hit.id)).toEqual(['long-note'])
  })

  it('collapses several matching windows to one hit per note', async () => {
    const projector = createEmbeddingProjector(() => '/vault')
    const body = Array.from({ length: 4 }, () => `saffron ${filler(80)}`).join('\n\n')
    await projector.project(upsert('repeat', body))
    const hits = await semanticNoteHits('saffron')
    expect(hits).toHaveLength(1)
  })

  it('replaces chunks when a note shrinks and removes them when it is deleted', async () => {
    const projector = createEmbeddingProjector(() => '/vault')
    await projector.project(upsert('n', `${filler(300)} saffron`))
    const before = count('vec_note_chunks')
    expect(before).toBeGreaterThan(1)
    expect(db.prepare('SELECT chunk_count FROM note_embedding_state').get()).toEqual({
      chunk_count: before
    })

    await projector.project(upsert('n', 'Now a short note about glacier travel.'))
    expect(count('vec_note_chunks')).toBe(0)
    expect(count('vec_notes')).toBe(1)

    await projector.project(upsert('n', `${filler(200)} saffron`))
    expect(count('vec_note_chunks')).toBeGreaterThan(0)
    await projector.project({ type: 'note.deleted', noteId: 'n' } as ProjectionEvent)
    expect(count('vec_note_chunks')).toBe(0)
    expect(count('vec_notes')).toBe(0)
    expect(count('note_embedding_state')).toBe(0)
  })

  it('serves the v4 head vector of a pre-chunk install, which the version bump leaves stale but in place', async () => {
    // State written by the previous build: head vector only, input_version 4, no chunk_count set.
    db.prepare('INSERT INTO vec_notes (note_id, embedding) VALUES (?, ?)').run(
      'old',
      embedText('glacier')
    )
    db.prepare('INSERT INTO note_embedding_state (note_id, input_version) VALUES (?, 4)').run('old')
    expect((await semanticNoteHits('glacier')).map((hit) => hit.id)).toEqual(['old'])
    expect(EMBEDDING_INPUT_VERSION).toBeGreaterThan(4)
  })
})
