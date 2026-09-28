/**
 * Pure scoring for the note-side similarity features: tag suggestions from a
 * note's nearest neighbours, and grouping a set of notes by embedding.
 *
 * No database, no model: the callers read vectors and tags, this module only
 * ranks them, so the behaviour is unit-testable without sqlite-vec.
 *
 * @module similarity/scoring
 */

import { corroboratedSimilarity } from '../inbox/folder-scoring'

/** Cosine similarity of two vectors. 0 when either has no length. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

// ============================================================================
// Tag suggestions
// ============================================================================

/** One neighbour of the note being categorised. */
export interface TagNeighbour {
  /** Cosine similarity to the note, -1..1. */
  similarity: number
  tags: readonly string[]
}

export interface ScoredTag {
  tag: string
  /** Blended confidence, 0..1. */
  confidence: number
  /** How many neighbours carry the tag. */
  support: number
}

export interface TagScoringOptions {
  /** Tags the note already has; never suggested again. Case-insensitive. */
  exclude?: Iterable<string>
  /** Neighbours less similar than this are ignored entirely. */
  minSimilarity?: number
  /** A tag needs at least this many neighbours behind it. */
  minSupport?: number
  /** Tags below this confidence are dropped. */
  minConfidence?: number
  limit?: number
}

/**
 * Rank the tags carried by a note's nearest neighbours.
 *
 * Each tag is scored the way the inbox scores a folder: by the similarities of
 * the notes that carry it, discounted when only one or two agree. A tag on a
 * single close note is weaker evidence than one shared by three reasonably
 * close notes, which is the "what do these notes have in common" signal the
 * feature is for. Tag identity is case-insensitive; the casing shown is the
 * one most neighbours use.
 */
export function scoreNeighbourTags(
  neighbours: readonly TagNeighbour[],
  options: TagScoringOptions = {}
): ScoredTag[] {
  const { minSimilarity = 0, minSupport = 1, minConfidence = 0, limit } = options
  const excluded = new Set([...(options.exclude ?? [])].map((tag) => tag.toLowerCase()))

  const byKey = new Map<string, { sims: number[]; spellings: Map<string, number> }>()
  for (const neighbour of neighbours) {
    if (neighbour.similarity < minSimilarity) continue
    // A note lists a tag once; guard anyway so a duplicate cannot double-count.
    const seen = new Set<string>()
    for (const tag of neighbour.tags) {
      const key = tag.toLowerCase()
      if (!key || excluded.has(key) || seen.has(key)) continue
      seen.add(key)
      const entry = byKey.get(key) ?? { sims: [], spellings: new Map<string, number>() }
      entry.sims.push(neighbour.similarity)
      entry.spellings.set(tag, (entry.spellings.get(tag) ?? 0) + 1)
      byKey.set(key, entry)
    }
  }

  const scored: ScoredTag[] = []
  for (const entry of byKey.values()) {
    if (entry.sims.length < minSupport) continue
    const confidence = corroboratedSimilarity(entry.sims)
    if (confidence < minConfidence) continue
    const tag = [...entry.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0]
    scored.push({ tag, confidence, support: entry.sims.length })
  }

  scored.sort((a, b) => b.confidence - a.confidence || b.support - a.support)
  return typeof limit === 'number' ? scored.slice(0, limit) : scored
}

// ============================================================================
// Clustering
// ============================================================================

export interface ClusterItem {
  id: string
  vector: Float32Array
}

export interface ClusterOptions {
  /**
   * Two groups merge only while the average similarity between their members
   * stays at or above this. Higher = tighter, smaller groups.
   */
  threshold: number
}

/**
 * Group items by embedding with average-linkage agglomerative clustering.
 *
 * Every item starts alone; the two groups with the highest average pairwise
 * similarity merge, repeatedly, until no pair clears `threshold`. Average
 * linkage (rather than single) keeps one bridging note from chaining two
 * unrelated topics into one group. No group count is asked for: the user
 * cannot know how many categories a board holds, which is why they asked.
 *
 * Deterministic for a given input order. O(n³) in the worst case, which is
 * why callers cap n.
 *
 * Returns groups of two or more ids, largest first; items that joined nothing
 * are returned separately.
 */
export function clusterBySimilarity(
  items: readonly ClusterItem[],
  options: ClusterOptions
): { groups: string[][]; ungrouped: string[] } {
  const n = items.length
  if (n === 0) return { groups: [], ungrouped: [] }

  // Pairwise similarity, computed once.
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = cosineSimilarity(items[i].vector, items[j].vector)
      sim[i][j] = value
      sim[j][i] = value
    }
  }

  // Each live cluster is a list of item indices; `link[a][b]` is the SUM of
  // pairwise similarities between clusters a and b, so the average is
  // link / (size a × size b) and a merge is an O(n) row update.
  const members: (number[] | null)[] = items.map((_, index) => [index])
  const link: number[][] = sim.map((row) => [...row])

  for (;;) {
    let bestA = -1
    let bestB = -1
    let best = -Infinity
    for (let a = 0; a < n; a++) {
      const ma = members[a]
      if (!ma) continue
      for (let b = a + 1; b < n; b++) {
        const mb = members[b]
        if (!mb) continue
        const average = link[a][b] / (ma.length * mb.length)
        if (average > best) {
          best = average
          bestA = a
          bestB = b
        }
      }
    }
    if (bestA < 0 || best < options.threshold) break

    const merged = [...(members[bestA] as number[]), ...(members[bestB] as number[])]
    members[bestA] = merged
    members[bestB] = null
    for (let c = 0; c < n; c++) {
      if (c === bestA || !members[c]) continue
      link[bestA][c] += link[bestB][c]
      link[c][bestA] = link[bestA][c]
    }
  }

  const groups: string[][] = []
  const ungrouped: string[] = []
  for (const cluster of members) {
    if (!cluster) continue
    const ids = [...cluster].sort((a, b) => a - b).map((index) => items[index].id)
    if (ids.length >= 2) groups.push(ids)
    else ungrouped.push(ids[0])
  }
  // Largest first; ties keep input order (Array.prototype.sort is stable).
  groups.sort((a, b) => b.length - a.length)
  return { groups, ungrouped }
}

/**
 * A name for a proposed group, from what its members already share: the tag
 * most of them carry, else the folder most of them sit in. `null` when nothing
 * is shared by at least half — the user names it, which beats a made-up label.
 */
export function suggestGroupName(
  members: readonly { tags: readonly string[]; folder: string }[]
): string | null {
  if (members.length === 0) return null
  const quorum = Math.max(2, Math.ceil(members.length / 2))

  const pickShared = (values: string[][]): string | null => {
    const counts = new Map<string, { count: number; spelling: string }>()
    for (const list of values) {
      for (const value of new Set(list.map((v) => v.toLowerCase()))) {
        const spelling = list.find((v) => v.toLowerCase() === value) ?? value
        const entry = counts.get(value) ?? { count: 0, spelling }
        entry.count++
        counts.set(value, entry)
      }
    }
    let winner: { count: number; spelling: string } | null = null
    for (const entry of counts.values()) {
      if (entry.count < quorum) continue
      if (!winner || entry.count > winner.count) winner = entry
    }
    return winner?.spelling ?? null
  }

  const tag = pickShared(members.map((member) => [...member.tags]))
  if (tag) return tag

  const folder = pickShared(members.map((member) => (member.folder ? [member.folder] : [])))
  if (folder) return folder.split('/').pop() ?? folder
  return null
}
