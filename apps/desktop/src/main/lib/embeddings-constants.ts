/**
 * Shared embedding constants that must be safe to import in non-Electron contexts
 * (for example database initialization in tests).
 */
import path from 'path'

/**
 * Stored vector width. EmbeddingGemma 2 emits 768d; it is trained with
 * Matryoshka (MRL), so the first 256 dims re-normalized keep almost all of the
 * quality (MTEB multilingual 60.41 vs 61.36 at 768d) at a third of the storage.
 */
export const EMBEDDING_DIMENSION = 256

/** transformers.js repo id the worker loads. */
export const EMBEDDING_MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'

/**
 * Quantization the worker loads. q4 is ~175MB; fp16/q4f16 are not an option:
 * the model card reports NaN/degraded output for EmbeddingGemma in fp16.
 */
export const EMBEDDING_MODEL_DTYPE = 'q4'

/**
 * Cosine similarity EmbeddingGemma 2 gives two unrelated notes.
 *
 * Its scores are compressed toward the top: measured on Turkish and English
 * notes (q4, 256d, symmetric `sentence similarity` prefix), unrelated pairs land
 * at 0.65-0.79 (median 0.71) and related pairs at 0.75-0.95. MiniLM put
 * unrelated notes near 0-0.2, and every threshold and "% match" in the app was
 * written against that range.
 */
export const EMBEDDING_SIMILARITY_FLOOR = 0.6

/**
 * Map a raw cosine similarity onto 0..1 so that "unrelated" sits near the bottom
 * instead of at 0.7. Median unrelated (0.71) -> 0.28, strongest unrelated pair
 * seen (0.79) -> 0.47, a cross-language duplicate (0.95) -> 0.87.
 */
export function calibrateSimilarity(cosine: number): number {
  const scaled = (cosine - EMBEDDING_SIMILARITY_FLOOR) / (1 - EMBEDDING_SIMILARITY_FLOOR)
  return Math.min(1, Math.max(0, scaled))
}

/**
 * Where the worker points transformers.js `env.cacheDir`. Shared with the bridge
 * so the crash report's model-cache probe reads the SAME directory the worker
 * downloads into — a probe that drifts from the worker's cache dir would report
 * "absent" forever and quietly answer the wrong question.
 */
export const transformersCacheDir = (userDataPath: string): string =>
  path.join(userDataPath, 'models', 'transformers')

/** Directory transformers.js writes this model's files into. */
export const embeddingModelCacheDir = (userDataPath: string): string =>
  path.join(transformersCacheDir(userDataPath), EMBEDDING_MODEL_REPO)

/**
 * The weights file transformers.js writes for `dtype: 'q4'`. The graph
 * (`model_q4.onnx`, ~0.5MB) is fetched first; the external data file is the
 * ~174MB one a torn download leaves short, so that is what the probe sizes.
 */
export const embeddingModelWeightsPath = (userDataPath: string): string =>
  path.join(embeddingModelCacheDir(userDataPath), 'onnx', 'model_q4.onnx_data')
