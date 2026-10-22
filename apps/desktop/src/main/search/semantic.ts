/**
 * Semantic leg of search: embed the typed query and read the nearest note
 * vectors from `vec_notes`. Hybrid merging with FTS lives in
 * `database/queries/search.ts`; this only produces the hits.
 *
 * @module search/semantic
 */

import { getDatabase, getRawIndexDatabase } from '../database'
import { getSetting } from '@main/database/queries/settings'
import { generateEmbedding, initEmbeddingModel, isModelLoaded } from '../lib/embeddings'
import { buildQueryEmbeddingInput } from '../lib/embedding-input'
import { EMBEDDING_QUERY_SIMILARITY_FLOOR } from '../lib/embeddings-constants'
import { createLogger } from '../lib/logger'
import type { SemanticHit } from '../database/queries/search-semantic-merge'

const logger = createLogger('Search:Semantic')

const AI_SETTINGS_KEY = 'ai.enabled'
const MIN_QUERY_LENGTH = 3
/** Neighbours read before the floor is applied. */
const NEIGHBOURS = 30

function isAIEnabled(): boolean {
  try {
    return getSetting(getDatabase(), AI_SETTINGS_KEY) !== 'false'
  } catch {
    return false
  }
}

/** FTS operator syntax (AND/OR/NOT, quoted phrases) asks for literal matches, not meaning. */
function hasOperators(text: string): boolean {
  return /\b(AND|OR|NOT)\b/.test(text) || /"[^"]+"/.test(text)
}

/**
 * Notes whose meaning is near `text`, best first. Empty when AI is off, the
 * query is too short or uses operators, or the model is not loaded yet: a
 * search never waits seconds on a model load, so the first one after launch
 * starts the load and answers from FTS alone.
 */
export async function semanticNoteHits(text: string): Promise<SemanticHit[]> {
  const query = text.trim()
  if (query.length < MIN_QUERY_LENGTH || hasOperators(query) || !isAIEnabled()) return []

  if (!isModelLoaded()) {
    void initEmbeddingModel().catch((error) => logger.warn('Search model warm-up failed', error))
    return []
  }

  try {
    const vector = await generateEmbedding(buildQueryEmbeddingInput(query))
    if (!vector) return []
    const rawDb = getRawIndexDatabase()
    const nearest = (table: 'vec_notes' | 'vec_note_chunks', idColumn: string) =>
      rawDb
        .prepare(
          `SELECT ${idColumn} AS id, distance FROM ${table}
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`
        )
        .all(vector, NEIGHBOURS) as Array<{ id: string; distance: number }>

    // A note is as near as its nearest window: the head vector or a later chunk
    // (`{note_id}#{n}`).
    const best = new Map<string, number>()
    const consider = (noteId: string, distance: number): void => {
      const cosine = 1 - distance
      if (cosine > (best.get(noteId) ?? -Infinity)) best.set(noteId, cosine)
    }
    for (const row of nearest('vec_notes', 'note_id')) consider(row.id, row.distance)
    for (const row of nearest('vec_note_chunks', 'chunk_id')) {
      consider(row.id.slice(0, row.id.lastIndexOf('#')), row.distance)
    }
    return [...best]
      .map(([id, cosine]) => ({ id, cosine }))
      .filter((hit) => hit.cosine >= EMBEDDING_QUERY_SIMILARITY_FLOOR)
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, NEIGHBOURS)
  } catch (error) {
    logger.warn('Semantic search failed, falling back to FTS', error)
    return []
  }
}
