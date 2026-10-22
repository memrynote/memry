/**
 * Embedding input shaping
 *
 * Builds the text fed to the embedding model for a note or a typed query. Pure
 * and side-effect free so it can be unit-tested.
 *
 * @module main/lib/embedding-input
 */

/**
 * Max characters in one model window, task prefix included. EmbeddingGemma 2
 * reads 8K tokens, so this is a latency and memory bound, not a context one: a
 * 4000-char window takes ~1.7s on CPU (q4) against ~40ms for a short one, and
 * attention cost grows faster than linearly with window length. A longer note
 * is split into several windows ({@link buildEmbeddingChunks}) instead of
 * widening this one, so peak memory per inference stays flat.
 */
export const MAX_EMBEDDING_INPUT_LENGTH = 4000

/**
 * Windows embedded per note. A note past this many windows is cut there, which
 * bounds the cost of one very large note (a pasted log, a book) at 16 inferences
 * and ~64K characters.
 */
export const MAX_EMBEDDING_CHUNKS = 16

/** Characters of note text a reader hands to {@link buildEmbeddingChunks}; the rest is never used. */
export const MAX_EMBEDDABLE_CONTENT_LENGTH = MAX_EMBEDDING_INPUT_LENGTH * MAX_EMBEDDING_CHUNKS

const MAX_CHUNK_TITLE_LENGTH = 200

/**
 * Title + body shorter than this has too little signal to embed. Checked before
 * the prefix is added: callers compare the built input against their own
 * minimum, and the prefix alone would clear it for a two-letter note.
 */
const MIN_EMBEDDING_TEXT_LENGTH = 10

/**
 * EmbeddingGemma 2 task prefixes, owned here so no caller writes one. A caller
 * names the task; this module decides the text.
 *
 * - `document`: a stored note read by search. Asymmetric with the query prefix
 *   below (`title: {title} | text: {content}` against
 *   `task: search result | query: {q}`).
 * - `similarity`: a note compared with another note (related notes, tag
 *   suggestions, grouping, filing). Both sides share the symmetric
 *   `task: sentence similarity | query: {title}\n{content}` prefix.
 *
 * Measured on 48 Turkish and English notes (6 topics, q4, 256d), the document
 * prefix separates same-topic from other-topic pairs worse than the similarity
 * prefix (pair AUC 0.793 vs 0.862, best pair F1 0.49 vs 0.62; similarity won
 * 200 of 200 bootstrap resamples) and leaves related pairs at raw cosine 0.50-0.66
 * against floors written for 0.75-0.95. The `classification` and `clustering`
 * prefixes landed between the two on every metric, and `code retrieval` ranked
 * code notes exactly as `search result` did, so none of those three is used.
 */
export type EmbeddingTask = 'document' | 'similarity'

const QUERY_PREFIX = 'task: search result | query: '
const SIMILARITY_PREFIX = 'task: sentence similarity | query: '

/**
 * Build the text fed to the model for one note or inbox item, for the given
 * task. The title leads so it survives truncation; an untitled note is marked
 * `title: none` for `document` and simply starts at its text for `similarity`.
 */
export function buildEmbeddingInput(
  parts: { title?: string | null; content?: string | null },
  task: EmbeddingTask
): string {
  const title = parts.title?.trim()
  const content = parts.content?.trim() ?? ''
  if ((title?.length ?? 0) + content.length < MIN_EMBEDDING_TEXT_LENGTH) return ''
  const input =
    task === 'similarity'
      ? `${SIMILARITY_PREFIX}${title ? `${title}\n` : ''}${content}`
      : `title: ${title || 'none'} | text: ${content}`
  return input.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/**
 * Split a note into model windows: the head window first (identical to
 * {@link buildEmbeddingInput} for the `document` task on a note that fits one window), then the rest,
 * each carrying the same title prefix. Windows break at a paragraph, line,
 * sentence, or word boundary in the second half of the window when one exists.
 * Empty when the note is too short to embed. Windows that are only a sliver
 * (under the minimum) are dropped, except the head.
 */
export function buildEmbeddingChunks(parts: {
  title?: string | null
  content?: string | null
}): string[] {
  const title = parts.title?.trim()
  const content = parts.content?.trim() ?? ''
  if ((title?.length ?? 0) + content.length < MIN_EMBEDDING_TEXT_LENGTH) return []

  const header = `title: ${title?.slice(0, MAX_CHUNK_TITLE_LENGTH) || 'none'} | text: `
  const budget = MAX_EMBEDDING_INPUT_LENGTH - header.length
  const pieces: string[] = []
  let rest = content
  while (pieces.length < MAX_EMBEDDING_CHUNKS) {
    if (rest.length <= budget) {
      pieces.push(rest)
      break
    }
    const cut = findChunkCut(rest, budget)
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return pieces
    .filter((piece, index) => index === 0 || piece.length >= MIN_EMBEDDING_TEXT_LENGTH)
    .map((piece) => `${header}${piece}`)
}

const CHUNK_BREAKS = ['\n\n', '\n', '. ', ' ']

function findChunkCut(text: string, budget: number): number {
  const window = text.slice(0, budget)
  for (const separator of CHUNK_BREAKS) {
    const at = window.lastIndexOf(separator)
    if (at >= budget / 2) return at + separator.length
  }
  return budget
}

/** Build the text fed to the model for a typed search query. */
export function buildQueryEmbeddingInput(query: string): string {
  const text = query.trim()
  if (!text) return ''
  return `${QUERY_PREFIX}${text}`.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/**
 * Bump when the text {@link buildEmbeddingInput} or {@link buildEmbeddingChunks}
 * produce changes, or a vector is added, so stored vectors are rebuilt.
 * v1 = content only (legacy); v2 = title + content; v3 = EmbeddingGemma 2 with
 * the `sentence similarity` task prefix (a different model, so every stored
 * vector is stale); v4 = the document prefix above; v5 = notes past one window
 * also get a vector per later window (`vec_note_chunks`); v6 = every note also gets
 * a `similarity` vector (`vec_note_similar`) for note-to-note features. Stale
 * vectors keep serving search until the background re-embed (note_embedding_state) replaces them.
 */
export const EMBEDDING_INPUT_VERSION = 6
