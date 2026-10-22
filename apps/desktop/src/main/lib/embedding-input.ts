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

/**
 * Split a note into model windows: the head window first (identical to
 * {@link buildEmbeddingInput} for a note that fits one window), then the rest,
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
 * Bump when {@link buildEmbeddingInput} changes so stored vectors are rebuilt.
 * v1 = content only (legacy); v2 = title + content; v3 = EmbeddingGemma 2 with
 * the `sentence similarity` task prefix (a different model, so every stored
 * vector is stale); v4 = the document prefix above; v5 = notes past one window
 * also get a vector per later window (`vec_note_chunks`). Stale vectors keep serving
 * until the background re-embed (note_embedding_state) replaces them.
 */
export const EMBEDDING_INPUT_VERSION = 5

/**
 * Bump when the bytes fed to the vision encoder or its settings change (for
 * example `EMBEDDING_IMAGE_SOFT_TOKENS`), so stored image vectors are rebuilt.
 * Stale vectors keep serving until the background re-embed
 * (image_embedding_state) replaces them. v2 = images with text and PDF pages are
 * embedded with that text and at `EMBEDDING_PAGE_SOFT_TOKENS` (#3129).
 */
export const IMAGE_EMBEDDING_INPUT_VERSION = 2

/**
 * Characters of a page's or image's own text that join its pixels in one
 * interleaved vector. The 8K-token window is shared: the page costs
 * `EMBEDDING_PAGE_SOFT_TOKENS` soft tokens and 2500 characters of OCR
 * text about 1K, so a page with its text stays near 1.3K tokens, well inside
 * the window and about the size of a text-only window.
 */
export const MAX_INTERLEAVED_TEXT_LENGTH = 2500

/**
 * The model input for a page or image together with the text read from it:
 * the document prefix, the text, then the image placeholder the processor
 * expands to the image's soft tokens. Null when there is too little text to
 * add signal, in which case the image is embedded alone.
 */
export function buildInterleavedInput(text: string | null | undefined): string | null {
  const body = text?.trim() ?? ''
  if (body.length < MIN_EMBEDDING_TEXT_LENGTH) return null
  return `title: none | text: ${body.slice(0, MAX_INTERLEAVED_TEXT_LENGTH)} <|image|>`
}
