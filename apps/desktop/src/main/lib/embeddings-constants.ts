/**
 * Shared embedding constants that must be safe to import in non-Electron contexts
 * (for example database initialization in tests).
 */
import path from 'path'

export const EMBEDDING_DIMENSION = 384

/** transformers.js repo id the worker loads. */
export const EMBEDDING_MODEL_REPO = 'Xenova/all-MiniLM-L6-v2'

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

/** The weights file transformers.js writes for `dtype: 'fp32'`. */
export const embeddingModelWeightsPath = (userDataPath: string): string =>
  path.join(embeddingModelCacheDir(userDataPath), 'onnx', 'model.onnx')
