/**
 * Embedding input shaping
 *
 * Builds the text fed to the embedding model for a note or query. Pure and
 * side-effect free so it can be unit-tested and shared by both the stored
 * note embeddings and the query embedding (they must match to compare).
 *
 * @module main/lib/embedding-input
 */

/** Max characters fed to the model (~its effective context window). */
const MAX_EMBEDDING_INPUT_LENGTH = 2000

/**
 * Build the text fed to the embedding model.
 *
 * The title goes first so it survives truncation — the model only reads its
 * first few hundred tokens, so the most signal-dense field must lead. Used for
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
  return segments.join('\n\n').slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/**
 * Bump when {@link buildEmbeddingInput} changes so stored vectors are rebuilt.
 * v1 = content only (legacy); v2 = title + content.
 */
export const EMBEDDING_INPUT_VERSION = 2
