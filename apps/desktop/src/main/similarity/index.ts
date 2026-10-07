/**
 * Note similarity from the local embeddings already stored in `vec_notes`.
 *
 * Three read-only answers, all computed on this device from vectors the
 * embedding projector wrote: the notes nearest to a note, the tags those
 * neighbours carry, and a grouping of a set of notes. Nothing here embeds
 * text — the query vector is the note's own stored vector — so no model load
 * and no inference sit on the request path, and no note text is read at all.
 *
 * @module similarity
 */

import { inArray } from 'drizzle-orm'
import {
  MAX_CLUSTER_NOTES,
  type NoteClustersResponse,
  type NoteTagSuggestionsResponse,
  type SimilarNoteItem,
  type SimilarNotesResponse
} from '@memry/contracts/notes-api'
import { noteCache, noteTags } from '@memry/db-schema/schema/notes-cache'
import { getDatabase, getIndexDatabase, getRawIndexDatabase } from '../database'
import { getSetting } from '@main/database/queries/settings'
import { getIncomingReferences, getOutgoingLinks } from '@main/database/queries/notes'
import { getPropertyRefsForNote } from '@main/database/queries/notes/property-ref-queries'
import { calibrateSimilarity } from '../lib/embeddings-constants'
import { createLogger } from '../lib/logger'
import { clusterBySimilarity, scoreNeighbourTags, suggestGroupName } from './scoring'

const log = createLogger('Similarity')

const AI_SETTINGS_KEY = 'ai.enabled'

const DEFAULT_SIMILAR_LIMIT = 5
/**
 * Neighbours below this similarity are not shown as "similar". Similarities
 * here are calibrated (calibrateSimilarity): EmbeddingGemma 2's raw cosine puts
 * unrelated notes at 0.65-0.79, which calibrates to ~0.1-0.47. 0.5 (raw 0.80)
 * clears the strongest unrelated pair measured on Turkish and English notes;
 * cross-language duplicates and same-topic notes (raw 0.81-0.95) stay. The
 * floor keeps a sparse vault from padding the list with whatever happens to be
 * least unrelated.
 */
const MIN_SIMILAR = 0.5

/** Neighbours read for tag suggestions. */
const TAG_NEIGHBOURS = 20
/**
 * Calibrated, raw cosine 0.76. Looser than {@link MIN_SIMILAR}: a tag also
 * needs {@link TAG_MIN_SUPPORT} neighbours agreeing, which filters the strays.
 */
const TAG_MIN_SIMILARITY = 0.4
/** A tag on one note is a coincidence; two notes agreeing is a pattern. */
const TAG_MIN_SUPPORT = 2
const TAG_MIN_CONFIDENCE = 0.3
const TAG_LIMIT = 3

/**
 * Average-linkage floor for grouping. Looser than {@link MIN_SIMILAR}: a
 * group's members are compared with each other on average, and a proposal the
 * user can rename or discard costs less than a note shown as "similar".
 * Raw cosine (clustering compares stored vectors directly, uncalibrated): 0.77
 * sits between the weakest related pair (0.75) and the strongest unrelated one
 * (0.79) measured for EmbeddingGemma 2; average linkage over a group pulls a
 * single stray below it.
 */
const CLUSTER_THRESHOLD = 0.77

function isEmbeddingEnabled(): boolean {
  try {
    return getSetting(getDatabase(), AI_SETTINGS_KEY) !== 'false'
  } catch {
    return false
  }
}

/** vec0 returns a float32 column as a Buffer; copy it into an aligned array. */
function toVector(blob: unknown): Float32Array | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) return null
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

function readVector(noteId: string): Float32Array | null {
  const row = getRawIndexDatabase()
    .prepare('SELECT embedding FROM vec_notes WHERE note_id = ?')
    .get(noteId) as { embedding: unknown } | undefined
  return row ? toVector(row.embedding) : null
}

function readVectors(noteIds: readonly string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  if (noteIds.length === 0) return out
  const statement = getRawIndexDatabase().prepare(
    'SELECT embedding FROM vec_notes WHERE note_id = ?'
  )
  // One point lookup per id: vec0 answers primary-key reads directly, and an
  // IN list over a virtual table is not guaranteed to use that path.
  for (const id of noteIds) {
    const row = statement.get(id) as { embedding: unknown } | undefined
    const vector = row ? toVector(row.embedding) : null
    if (vector) out.set(id, vector)
  }
  return out
}

/** Nearest stored vectors, closest first, as cosine similarity. */
function nearest(vector: Float32Array, k: number): Array<{ noteId: string; similarity: number }> {
  const rows = getRawIndexDatabase()
    .prepare(
      `SELECT note_id, distance FROM vec_notes
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(vector, k) as Array<{ note_id: string; distance: number }>
  return rows.map((row) => ({
    noteId: row.note_id,
    similarity: calibrateSimilarity(1 - row.distance)
  }))
}

/** Notes already connected to `noteId` either way, which a "similar" list must not repeat. */
function linkedNoteIds(noteId: string): Set<string> {
  const db = getIndexDatabase()
  const linked = new Set<string>()
  for (const link of getOutgoingLinks(db, noteId)) {
    if (link.targetId) linked.add(link.targetId)
  }
  for (const ref of getIncomingReferences(db, noteId)) linked.add(ref.sourceNoteId)
  for (const ref of getPropertyRefsForNote(db, noteId)) {
    if (ref.targetType === 'note') linked.add(ref.targetId)
  }
  return linked
}

function tagsByNote(noteIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (noteIds.length === 0) return out
  const rows = getIndexDatabase()
    .select({ noteId: noteTags.noteId, tag: noteTags.tag })
    .from(noteTags)
    .where(inArray(noteTags.noteId, [...noteIds]))
    .all()
  for (const row of rows) {
    const list = out.get(row.noteId)
    if (list) list.push(row.tag)
    else out.set(row.noteId, [row.tag])
  }
  return out
}

/**
 * The notes most similar to `noteId`, excluding itself and every note it
 * already links to or is linked from.
 */
export function getSimilarNotes(
  noteId: string,
  limit: number = DEFAULT_SIMILAR_LIMIT
): SimilarNotesResponse {
  if (!isEmbeddingEnabled()) return { status: 'disabled', notes: [] }

  try {
    const vector = readVector(noteId)
    if (!vector) return { status: 'no-embedding', notes: [] }

    const exclude = linkedNoteIds(noteId)
    exclude.add(noteId)
    // Over-fetch by the excluded count so filtering cannot starve the list.
    const hits = nearest(vector, limit + exclude.size).filter(
      (hit) => !exclude.has(hit.noteId) && hit.similarity >= MIN_SIMILAR
    )
    if (hits.length === 0) return { status: 'ready', notes: [] }

    const info = new Map(
      getIndexDatabase()
        .select({
          id: noteCache.id,
          title: noteCache.title,
          path: noteCache.path,
          emoji: noteCache.emoji,
          snippet: noteCache.snippet
        })
        .from(noteCache)
        .where(
          inArray(
            noteCache.id,
            hits.map((hit) => hit.noteId)
          )
        )
        .all()
        .map((row) => [row.id, row])
    )

    const notes: SimilarNoteItem[] = []
    for (const hit of hits) {
      const row = info.get(hit.noteId)
      // A vector can briefly outlive its note (the prune runs on reconcile).
      if (!row) continue
      notes.push({
        id: row.id,
        title: row.title,
        path: row.path,
        emoji: row.emoji ?? null,
        snippet: row.snippet ?? null,
        similarity: Math.min(1, hit.similarity)
      })
      if (notes.length >= limit) break
    }
    return { status: 'ready', notes }
  } catch (error) {
    log.error('Similar notes lookup failed', { noteId, error })
    return { status: 'ready', notes: [] }
  }
}

/**
 * Tags a note's nearest neighbours share, for a note that has none yet. Only
 * suggested, never written: accepting one goes through the ordinary note
 * update path in the renderer.
 */
export function getTagSuggestions(noteId: string): NoteTagSuggestionsResponse {
  if (!isEmbeddingEnabled()) return { status: 'disabled', tags: [] }

  try {
    const vector = readVector(noteId)
    if (!vector) return { status: 'no-embedding', tags: [] }

    const hits = nearest(vector, TAG_NEIGHBOURS + 1).filter((hit) => hit.noteId !== noteId)
    const tags = tagsByNote([noteId, ...hits.map((hit) => hit.noteId)])

    const scored = scoreNeighbourTags(
      hits.map((hit) => ({ similarity: hit.similarity, tags: tags.get(hit.noteId) ?? [] })),
      {
        exclude: tags.get(noteId) ?? [],
        minSimilarity: TAG_MIN_SIMILARITY,
        minSupport: TAG_MIN_SUPPORT,
        minConfidence: TAG_MIN_CONFIDENCE,
        limit: TAG_LIMIT
      }
    )
    return { status: 'ready', tags: scored }
  } catch (error) {
    log.error('Tag suggestions failed', { noteId, error })
    return { status: 'ready', tags: [] }
  }
}

/**
 * Proposed groups for a set of notes (a canvas selection or board). Nothing is
 * created here; the renderer turns an accepted group into a frame.
 */
export function clusterNotes(noteIds: readonly string[]): NoteClustersResponse {
  if (!isEmbeddingEnabled()) return { status: 'disabled', groups: [], ungrouped: [], missing: [] }

  const unique = [...new Set(noteIds)].slice(0, MAX_CLUSTER_NOTES)
  const vectors = readVectors(unique)
  const missing = unique.filter((id) => !vectors.has(id))
  const items = unique.flatMap((id) => {
    const vector = vectors.get(id)
    return vector ? [{ id, vector }] : []
  })

  const { groups, ungrouped } = clusterBySimilarity(items, { threshold: CLUSTER_THRESHOLD })

  const grouped = groups.flat()
  const tags = tagsByNote(grouped)
  const info = new Map<string, { title: string; folder: string }>()
  if (grouped.length > 0) {
    for (const row of getIndexDatabase()
      .select({ id: noteCache.id, title: noteCache.title, path: noteCache.path })
      .from(noteCache)
      .where(inArray(noteCache.id, grouped))
      .all()) {
      info.set(row.id, { title: row.title, folder: row.path.split('/').slice(0, -1).join('/') })
    }
  }

  return {
    status: 'ready',
    groups: groups.map((ids) => ({
      noteIds: ids,
      titles: ids.map((id) => info.get(id)?.title ?? ''),
      suggestedName: suggestGroupName(
        ids.map((id) => ({ tags: tags.get(id) ?? [], folder: info.get(id)?.folder ?? '' }))
      )
    })),
    ungrouped,
    missing
  }
}
