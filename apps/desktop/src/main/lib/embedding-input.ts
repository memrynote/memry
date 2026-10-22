/**
 * Embedding input shaping
 *
 * Builds the text fed to the embedding model for a note or a typed query. Pure
 * and side-effect free so it can be unit-tested.
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
 * Title + body shorter than this has too little signal to embed. Checked before
 * the prefix is added: callers compare the built input against their own
 * minimum, and the prefix alone would clear it for a two-letter note.
 */
const MIN_EMBEDDING_TEXT_LENGTH = 10

/**
 * EmbeddingGemma 2 retrieval prefixes. A stored note is a document and a typed
 * search is a query, so the two sides use the model's asymmetric pair
 * (`title: {title} | text: {content}` and `task: search result | query: {q}`).
 * Note-to-note features (related notes, filing, tags, grouping) compare two
 * documents, which share one prefix and so stay symmetric.
 */
const QUERY_PREFIX = 'task: search result | query: '

/**
 * Build the text fed to the model for a stored note or inbox item. The title
 * leads so it survives truncation; `title: none` marks an untitled note.
 */
export function buildEmbeddingInput(parts: {
  title?: string | null
  content?: string | null
}): string {
  const title = parts.title?.trim()
  const content = parts.content?.trim() ?? ''
  if ((title?.length ?? 0) + content.length < MIN_EMBEDDING_TEXT_LENGTH) return ''
  return `title: ${title || 'none'} | text: ${content}`.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/** Build the text fed to the model for a typed search query. */
export function buildQueryEmbeddingInput(query: string): string {
  const text = query.trim()
  if (!text) return ''
  return `${QUERY_PREFIX}${text}`.slice(0, MAX_EMBEDDING_INPUT_LENGTH)
}

/**
 * Bump when {@link buildEmbeddingInput} changes so stored vectors are rebuilt.
 * v1 = content only (legacy); v2 = title + content; v3 = EmbeddingGemma 2 with
 * the `sentence similarity` task prefix (a different model, so every stored
 * vector is stale); v4 = the document prefix above. Stale vectors keep serving
 * until the background re-embed (note_embedding_state) replaces them.
 */
export const EMBEDDING_INPUT_VERSION = 4
