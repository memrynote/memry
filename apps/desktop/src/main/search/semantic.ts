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
    const rows = getRawIndexDatabase()
      .prepare(
        `SELECT note_id, distance FROM vec_notes
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      )
      .all(vector, NEIGHBOURS) as Array<{ note_id: string; distance: number }>
    return rows
      .map((row) => ({ id: row.note_id, cosine: 1 - row.distance }))
      .filter((hit) => hit.cosine >= EMBEDDING_QUERY_SIMILARITY_FLOOR)
  } catch (error) {
    logger.warn('Semantic search failed, falling back to FTS', error)
    return []
  }
}
