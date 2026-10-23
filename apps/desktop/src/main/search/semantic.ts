/**
 * Semantic leg of search: embed the typed query and read the nearest note
 * vectors from `vec_notes`. Hybrid merging with FTS lives in
 * `database/queries/search.ts`; this only produces the hits.
 *
 * @module search/semantic
 */

import { getDatabase, getRawIndexDatabase } from '../database'
import { nearestVoiceItems } from '../database/voice-vectors'
import { getSetting } from '@main/database/queries/settings'
import { generateEmbedding, initEmbeddingModel, isModelLoaded } from '../lib/embeddings'
import { buildQueryEmbeddingInput } from '../lib/embedding-input'
import {
  EMBEDDING_AUDIO_QUERY_SIMILARITY_FLOOR,
  EMBEDDING_IMAGE_QUERY_SIMILARITY_FLOOR,
  EMBEDDING_QUERY_SIMILARITY_FLOOR
} from '../lib/embeddings-constants'
import { isImageEmbeddingEnabled } from '../lib/image-embedding'
import { nearestImageVectors } from '../database/queries/image-embeddings'
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
 * Notes, voice memos, and notes whose images' content is near `text`, best first. Empty when AI is off, the
 * query is too short or uses operators, or the model is not loaded yet: a
 * search never waits seconds on a model load, so the first one after launch
 * starts the load and answers from FTS alone.
 */
export async function semanticNoteHits(text: string): Promise<SemanticHit[]> {
  const query = text.trim()
  if (query.length < MIN_QUERY_LENGTH || hasOperators(query) || !isAIEnabled()) return []

  if (!isModelLoaded()) {
    void initEmbeddingModel().catch((error) => {
      logger.warn('Search model warm-up failed', error)
    })
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
    const consider = (noteId: string, cosine: number): void => {
      if (cosine > (best.get(noteId) ?? -Infinity)) best.set(noteId, cosine)
    }
    for (const row of nearest('vec_notes', 'note_id')) consider(row.id, 1 - row.distance)
    for (const row of nearest('vec_note_chunks', 'chunk_id')) {
      consider(row.id.slice(0, row.id.lastIndexOf('#')), 1 - row.distance)
    }
    for (const [id, cosine] of best) {
      if (cosine < EMBEDDING_QUERY_SIMILARITY_FLOOR) best.delete(id)
    }
    if (isImageEmbeddingEnabled()) {
      // An image answers for the note that owns it: the image itself when filed,
      // else the note that embeds it. Its floor is higher (text-to-image cosines
      // run lower and overlap more), and the hit is shifted down by the gap so
      // the merge scores both kinds of hit by the same distance above their floor.
      const shift = EMBEDDING_IMAGE_QUERY_SIMILARITY_FLOOR - EMBEDDING_QUERY_SIMILARITY_FLOOR
      try {
        for (const hit of nearestImageVectors(rawDb, vector, NEIGHBOURS)) {
          if (hit.cosine >= EMBEDDING_IMAGE_QUERY_SIMILARITY_FLOOR) {
            consider(hit.noteId, hit.cosine - shift)
          }
        }
      } catch (error) {
        // The image leg must not take the note hits down with it.
        logger.warn('Image search failed, answering from note vectors', error)
      }
    }
    const notes = [...best]
      .map(([id, cosine]) => ({ id, cosine }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, NEIGHBOURS)
    // Memos answer for themselves. An audio-embedded memo has the stricter audio
    // floor, shifted down by the gap like images so the merge scores every kind
    // of hit by its distance above its own floor.
    const audioShift = EMBEDDING_AUDIO_QUERY_SIMILARITY_FLOOR - EMBEDDING_QUERY_SIMILARITY_FLOOR
    const voice: SemanticHit[] = []
    try {
      for (const hit of nearestVoiceItems(rawDb, vector, NEIGHBOURS)) {
        if (hit.source === 'transcript') {
          if (hit.cosine >= EMBEDDING_QUERY_SIMILARITY_FLOOR) voice.push(hit)
        } else if (hit.cosine >= EMBEDDING_AUDIO_QUERY_SIMILARITY_FLOOR) {
          voice.push({ id: hit.id, cosine: hit.cosine - audioShift })
        }
      }
    } catch (error) {
      // The voice leg must not take the note hits down with it.
      logger.warn('Voice memo search failed, answering from note vectors', error)
    }
    return [...notes, ...voice].sort((a, b) => b.cosine - a.cosine)
  } catch (error) {
    logger.warn('Semantic search failed, falling back to FTS', error)
    return []
  }
}
