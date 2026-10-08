/**
 * Embedding input shaping
 *
 * Builds the text fed to the embedding model for a note or query. Pure and
 * side-effect free so it can be unit-tested and shared by both the stored
 * note embeddings and the query embedding (they must match to compare).
 *
 * @module main/lib/embedding-input
 */

/**
 * Max characters fed to the model, task prefix included. EmbeddingGemma 2 reads
 * 8K tokens, so this is a latency bound, not a context one: a 4000-char note
 * takes ~1.7s on CPU (q4) against ~40ms for a short one.
 */
export const MAX_EMBEDDING_INPUT_LENGTH = 4000

/**
 * EmbeddingGemma task instruction. One symmetric prefix for notes, inbox items
 * and queries alike: every comparison in the app is note-to-note similarity
 * (related notes, filing suggestions, tags, grouping), not asymmetric search.
 */
/**
 * Title + body shorter than this has too little signal to embed. Checked before
 * the task prefix is added: callers compare the built input against their own
 * minimum, and the prefix alone would clear it for a two-letter note.
 */
const MIN_EMBEDDING_TEXT_LENGTH = 10

export const EMBEDDING_TASK_PREFIX = 'task: sentence similarity | query: '

/**
 * Build the text fed to the embedding model.
 *
 * The title goes first so it survives truncation, so the most signal-dense
 * field always leads. Used for
 * BOTH stored note embeddings and the query embedding, so the two stay
 * symmetric (eng review T7 / Codex #10).
 */
export function buildEmbeddingInput(parts: {
  title?: string | null
  content?: string | null
}): string {
  const segments = [parts.title, parts.content]
    .map((segment) => segment?.trim())
    .filter((segment): segment is string => Boolean(segment))
  const text = segments.join('\n\n')
  if (text.length < MIN_EMBEDDING_TEXT_LENGTH) return ''
  return `${EMBEDDING_TASK_PREFIX}${text}`.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/**
 * Bump when {@link buildEmbeddingInput} changes so stored vectors are rebuilt.
 * v1 = content only (legacy); v2 = title + content; v3 = EmbeddingGemma 2 with
 * the `sentence similarity` task prefix (a different model, so every stored
 * vector is stale).
 */
export const EMBEDDING_INPUT_VERSION = 3
