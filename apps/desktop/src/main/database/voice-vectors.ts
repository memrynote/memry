/**
 * Voice memo vectors in the index DB.
 *
 * `vec_voice` holds one row per embedded window (`<itemId>#<n>`) and
 * `voice_embedding_state` records how an item was embedded, so a changed input
 * is re-embedded in the background while the old vectors keep answering.
 * Both are derived data, rebuilt from the inbox and its audio files, and live
 * only in index.db. They are created here, on first use, like `vec_notes`
 * (vec0 tables are outside Drizzle), so opening a vault changes no schema.
 *
 * @module main/database/voice-vectors
 */

import { EMBEDDING_DIMENSION } from '../lib/embeddings-constants'
import type { RawIndexDb } from './types'

/** What a voice memo's vectors were computed from. */
export type VoiceVectorSource = 'transcript' | 'audio'

export interface VoiceVectorState {
  source: VoiceVectorSource
  inputVersion: number
  chunks: number
}

const ensured = new WeakSet<RawIndexDb>()

export function ensureVoiceVectorTables(db: RawIndexDb): void {
  if (ensured.has(db)) return
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_voice USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSION}] distance_metric=cosine
    );
    CREATE TABLE IF NOT EXISTS voice_embedding_state (
      item_id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      input_version INTEGER NOT NULL,
      chunks INTEGER NOT NULL
    );
  `)
  ensured.add(db)
}

export function readVoiceVectorStates(db: RawIndexDb): Map<string, VoiceVectorState> {
  ensureVoiceVectorTables(db)
  const rows = db
    .prepare('SELECT item_id, source, input_version, chunks FROM voice_embedding_state')
    .all() as Array<{
    item_id: string
    source: VoiceVectorSource
    input_version: number
    chunks: number
  }>
  return new Map(
    rows.map((row) => [
      row.item_id,
      { source: row.source, inputVersion: row.input_version, chunks: row.chunks }
    ])
  )
}

export function deleteVoiceVectors(db: RawIndexDb, itemId: string): void {
  ensureVoiceVectorTables(db)
  const state = db
    .prepare('SELECT chunks FROM voice_embedding_state WHERE item_id = ?')
    .get(itemId) as { chunks: number } | undefined
  const remove = db.prepare('DELETE FROM vec_voice WHERE chunk_id = ?')
  db.transaction(() => {
    for (let n = 0; n < (state?.chunks ?? 0); n++) remove.run(`${itemId}#${n}`)
    db.prepare('DELETE FROM voice_embedding_state WHERE item_id = ?').run(itemId)
  })()
}

/** Replace every vector of an item with `vectors`, in one transaction. */
export function replaceVoiceVectors(
  db: RawIndexDb,
  itemId: string,
  source: VoiceVectorSource,
  inputVersion: number,
  vectors: Float32Array[]
): void {
  ensureVoiceVectorTables(db)
  const insert = db.prepare('INSERT INTO vec_voice (chunk_id, embedding) VALUES (?, ?)')
  db.transaction(() => {
    deleteVoiceVectors(db, itemId)
    vectors.forEach((vector, n) => insert.run(`${itemId}#${n}`, vector))
    db.prepare(
      'INSERT INTO voice_embedding_state (item_id, source, input_version, chunks) VALUES (?, ?, ?, ?)'
    ).run(itemId, source, inputVersion, vectors.length)
  })()
}

/**
 * Inbox items whose vectors are nearest `vector`, best first, one hit per item
 * (its best window), with what the vectors were computed from. Cosine
 * similarity, not distance.
 */
export function nearestVoiceItems(
  db: RawIndexDb,
  vector: Float32Array,
  neighbours: number
): Array<{ id: string; cosine: number; source: VoiceVectorSource }> {
  ensureVoiceVectorTables(db)
  const rows = db
    .prepare(
      `SELECT chunk_id, distance FROM vec_voice
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(vector, neighbours) as Array<{ chunk_id: string; distance: number }>
  const best = new Map<string, number>()
  for (const row of rows) {
    const id = row.chunk_id.slice(0, row.chunk_id.lastIndexOf('#'))
    if (!best.has(id)) best.set(id, 1 - row.distance)
  }
  const sources = db.prepare('SELECT item_id, source FROM voice_embedding_state')
  const sourceOf = new Map(
    (sources.all() as Array<{ item_id: string; source: VoiceVectorSource }>).map((row) => [
      row.item_id,
      row.source
    ])
  )
  return [...best].flatMap(([id, cosine]) => {
    const source = sourceOf.get(id)
    return source ? [{ id, cosine, source }] : []
  })
}
