/**
 * Folder scoring (pure)
 *
 * Aggregates per-note similarity hits into ranked folder suggestions.
 * Pure and side-effect free so the scoring behaviour is unit-testable
 * without database or embedding mocks.
 *
 * @module inbox/folder-scoring
 */

/** A single matched note, reduced to the folder it lives in + its similarity. */
export interface FolderHit {
  /** Folder path the matched note lives in ('' = root). */
  folder: string
  /** Similarity score of the matched note, 0..1 (higher = closer). */
  similarity: number
}

/** A ranked folder suggestion. */
export interface FolderScore {
  path: string
  /** Blended confidence, 0..1. */
  confidence: number
  /** Number of distinct hits that contributed to this folder. */
  support: number
}

/** Only a folder's best few hits count, so volume alone can't win. */
const SUPPORT_CAP = 3

/** A folder backed by a single note is discounted; corroboration removes it. */
const LONE_HIT_PENALTY = 0.3

/** Per-level discount when a hit rolls up to an ancestor folder. */
const ANCESTOR_DECAY = 0.8

/** Mean of the top-{@link SUPPORT_CAP} similarities for one folder. */
function meanTopK(sims: number[]): number {
  const top = [...sims].sort((a, b) => b - a).slice(0, SUPPORT_CAP)
  return top.reduce((sum, s) => sum + s, 0) / top.length
}

/**
 * Proper ancestor folders of `folder`, nearest first, excluding root ('').
 * 'a/b/c' → ['a/b', 'a']; 'recipes' → [] (its only ancestor is root).
 * Stopping before root keeps a flat vault from vacuuming all evidence into ''.
 */
function ancestorsOf(folder: string): string[] {
  if (!folder) return []
  const parts = folder.split('/')
  const out: string[] = []
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

/**
 * Score and rank folders from per-note similarity hits.
 *
 * A folder's confidence is the mean of its best few hits, discounted when
 * only a single note backs it. Capping the support at {@link SUPPORT_CAP}
 * stops a large mediocre folder from out-ranking a small excellent cluster.
 */
export function scoreFolders(hits: FolderHit[]): FolderScore[] {
  const byFolder = new Map<string, number[]>()
  const add = (folder: string, similarity: number): void => {
    const sims = byFolder.get(folder)
    if (sims) sims.push(similarity)
    else byFolder.set(folder, [similarity])
  }

  for (const hit of hits) {
    add(hit.folder, hit.similarity)
    // Roll the hit up to each ancestor, discounted per level, so a parent can
    // win when evidence is split across its child folders (D9).
    ancestorsOf(hit.folder).forEach((ancestor, depth) => {
      add(ancestor, hit.similarity * ANCESTOR_DECAY ** (depth + 1))
    })
  }

  const scores: FolderScore[] = []
  for (const [path, sims] of byFolder) {
    const support = sims.length
    const corroboration = 1 - LONE_HIT_PENALTY / Math.min(support, SUPPORT_CAP)
    scores.push({ path, confidence: meanTopK(sims) * corroboration, support })
  }

  return scores.sort((a, b) => b.confidence - a.confidence)
}
