/**
 * Folder scoring (pure)
 *
 * Scores candidate folders for an inbox item by blending several signals:
 * note-similarity (aggregated per folder), folder-name match, and member-tag
 * overlap. Pure and side-effect free so the scoring behaviour is unit-testable
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
  /** Title of the matched note, used to build reason text. */
  noteTitle?: string
}

/** The per-folder signal inputs to {@link scoreFolders}. */
export interface FolderSignals {
  /** Per-note similarity hits. */
  hits?: FolderHit[]
  /** Folder path → name-token match score, 0..1. */
  nameMatches?: Map<string, number>
  /** Folder path → member-tag overlap score, 0..1. */
  tagMatches?: Map<string, number>
  /** Folders to drop from the results (e.g. the note's current folder). */
  exclude?: Iterable<string>
  /** Drop folders whose blended confidence is below this floor. */
  minConfidence?: number
  /** Max number of folders to return. */
  limit?: number
}

/** A ranked folder suggestion. */
export interface FolderScore {
  path: string
  /** Blended confidence, 0..1. */
  confidence: number
  /** Number of similarity hits that contributed to this folder. */
  support: number
  /** Title of the closest matching note in this folder, if any. */
  topNoteTitle?: string
  /** The individual signal sub-scores that produced the confidence. */
  components: { sim: number; name: number; tag: number }
}

/** Only a folder's best few hits count, so volume alone can't win. */
const SUPPORT_CAP = 3

/** A folder backed by a single note is discounted; corroboration removes it. */
const LONE_HIT_PENALTY = 0.3

/** Per-level discount when a hit rolls up to an ancestor folder. */
const ANCESTOR_DECAY = 0.8

/** Blend weights: similarity is the most reliable signal, name next, tag last. */
const W_SIM = 0.6
const W_NAME = 0.25
const W_TAG = 0.15

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

interface Contribution {
  similarity: number
  noteTitle?: string
}

interface SimAggregate {
  score: number
  support: number
  topNoteTitle?: string
}

/** Aggregate similarity hits (with ancestor rollup) into a per-folder score. */
function aggregateSimilarity(hits: FolderHit[]): Map<string, SimAggregate> {
  const contribs = new Map<string, Contribution[]>()
  const add = (folder: string, similarity: number, noteTitle?: string): void => {
    const list = contribs.get(folder)
    if (list) list.push({ similarity, noteTitle })
    else contribs.set(folder, [{ similarity, noteTitle }])
  }

  for (const hit of hits) {
    add(hit.folder, hit.similarity, hit.noteTitle)
    // Roll the hit up to each ancestor, discounted per level, so a parent can
    // win when evidence is split across its child folders (D9).
    ancestorsOf(hit.folder).forEach((ancestor, depth) => {
      add(ancestor, hit.similarity * ANCESTOR_DECAY ** (depth + 1), hit.noteTitle)
    })
  }

  const out = new Map<string, SimAggregate>()
  for (const [folder, list] of contribs) {
    const support = list.length
    const corroboration = 1 - LONE_HIT_PENALTY / Math.min(support, SUPPORT_CAP)
    const score = meanTopK(list.map((c) => c.similarity)) * corroboration
    const top = list.reduce((best, c) => (c.similarity > best.similarity ? c : best))
    out.set(folder, { score, support, topNoteTitle: top.noteTitle })
  }
  return out
}

/**
 * Score and rank candidate folders from the available signals.
 *
 * A folder's confidence is a weighted average over whichever signals are
 * present for it: aggregated note-similarity (a cluster beats a single fluke,
 * volume can't win on its own), folder-name match, and member-tag overlap.
 * Folders surfaced by name/tag alone (no similarity hits) are valid candidates
 * — that is what keeps cold-start and folder-centric suggestions working.
 */
export function scoreFolders(input: FolderSignals): FolderScore[] {
  const { hits = [], nameMatches, tagMatches, exclude, minConfidence = 0, limit } = input
  const excluded = new Set(exclude ?? [])

  const simByFolder = aggregateSimilarity(hits)

  const candidates = new Set<string>(simByFolder.keys())
  nameMatches?.forEach((_, folder) => candidates.add(folder))
  tagMatches?.forEach((_, folder) => candidates.add(folder))

  const scores: FolderScore[] = []
  for (const path of candidates) {
    if (excluded.has(path)) continue

    const sim = simByFolder.get(path)
    const simScore = sim?.score ?? 0
    const nameScore = nameMatches?.get(path) ?? 0
    const tagScore = tagMatches?.get(path) ?? 0

    let weighted = 0
    let weight = 0
    if (sim) {
      weighted += simScore * W_SIM
      weight += W_SIM
    }
    if (nameScore > 0) {
      weighted += nameScore * W_NAME
      weight += W_NAME
    }
    if (tagScore > 0) {
      weighted += tagScore * W_TAG
      weight += W_TAG
    }
    if (weight === 0) continue

    const confidence = weighted / weight
    if (confidence < minConfidence) continue

    scores.push({
      path,
      confidence,
      support: sim?.support ?? 0,
      topNoteTitle: sim?.topNoteTitle,
      components: { sim: simScore, name: nameScore, tag: tagScore }
    })
  }

  scores.sort((a, b) => b.confidence - a.confidence)
  return typeof limit === 'number' ? scores.slice(0, limit) : scores
}
