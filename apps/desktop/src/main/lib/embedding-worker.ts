import { createLogger } from './logger'
import { installWorkerLogForwarding } from './log-forward'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_DTYPE,
  EMBEDDING_MODEL_REPO,
  transformersCacheDir
} from './embeddings-constants'
import { MAX_EMBEDDING_INPUT_LENGTH } from './embedding-input'
import type {
  EmbeddingMainToWorkerMessage,
  EmbeddingProgressPhase,
  EmbeddingWorkerToMainMessage
} from './embedding-model-protocol'

const logger = createLogger('Embeddings:Worker')

/**
 * Ceiling on the orderly teardown below. Comfortably under the main process's
 * SHUTDOWN_TIMEOUT_MS (3s, embeddings.ts), so a wedged disposal still exits on
 * its own terms rather than being force-killed and reported as a teardown death.
 */
const SHUTDOWN_TIMEOUT_MS = 1_500

interface ModelProgress {
  status: string
  file?: string
  loaded?: number
  total?: number
}

interface TextEmbedder {
  embed(text: string): Promise<Float32Array>
  dispose(): Promise<void>
}

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('embedding-worker.ts must be run as an Electron utility process')
}

installWorkerLogForwarding('Embeddings')

let extractor: TextEmbedder | null = null
let loadPromise: Promise<TextEmbedder> | null = null

function getUserDataPath(): string {
  const userDataPath = process.env.MEMRY_USER_DATA_PATH

  if (!userDataPath) {
    throw new Error('MEMRY_USER_DATA_PATH is not configured')
  }

  return userDataPath
}

function getTransformersCacheDir(): string {
  return transformersCacheDir(getUserDataPath())
}

function emitProgress(phase: EmbeddingProgressPhase, progress: number, status: string): void {
  parentPort.postMessage({
    type: 'progress',
    phase,
    progress,
    status
  } satisfies EmbeddingWorkerToMainMessage)
}

async function loadEmbeddingPipeline() {
  if (extractor) {
    return extractor
  }

  if (loadPromise) {
    return loadPromise
  }

  emitProgress('loading', 0, 'Initializing embedding model...')

  loadPromise = (async () => {
    const { AutoConfig, AutoModel, AutoTokenizer, env } = await import('@huggingface/transformers')
    env.cacheDir = getTransformersCacheDir()

    // Download progress across every file, weighted by size: the tokenizer
    // (~32MB) and the weights (~175MB) download in parallel.
    const files = new Map<string, { loaded: number; total: number }>()
    const progress_callback = (progress: ModelProgress): void => {
      if (progress.status === 'progress' && progress.file) {
        files.set(progress.file, { loaded: progress.loaded ?? 0, total: progress.total ?? 0 })
        let loaded = 0
        let total = 0
        for (const file of files.values()) {
          loaded += file.loaded
          total += file.total
        }
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0
        emitProgress('downloading', pct, `Downloading model: ${pct}%`)
        return
      }

      if (progress.status === 'done') {
        emitProgress('loading', 95, 'Finalizing model...')
      }
    }

    // Text only. EmbeddingGemma 2 is multimodal and transformers.js builds a
    // vision and an audio session whenever the config carries their sections;
    // clearing them loads just the text graph (model_q4.onnx + data) and never
    // downloads the ~300MB of encoders. Loading through AutoModel rather than
    // pipeline() also matters: pipeline() probes the encoder files for its
    // progress totals even when they are never used.
    const config = await AutoConfig.from_pretrained(EMBEDDING_MODEL_REPO, { progress_callback })
    const configSections = config as unknown as Record<string, unknown>
    configSections.vision_config = null
    configSections.audio_config = null

    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(EMBEDDING_MODEL_REPO, { progress_callback }),
      AutoModel.from_pretrained(EMBEDDING_MODEL_REPO, {
        config,
        dtype: EMBEDDING_MODEL_DTYPE,
        device: 'cpu',
        progress_callback
      })
    ])

    const embedder: TextEmbedder = {
      async embed(text: string): Promise<Float32Array> {
        const inputs = tokenizer([text], { padding: true, truncation: true })
        // `sentence_embedding` is the model's own mean-pooled, projected and
        // L2-normalized 768d output.
        const output = (await model(inputs)) as { sentence_embedding: { data: ArrayLike<number> } }
        return truncateEmbedding(output.sentence_embedding.data)
      },
      async dispose(): Promise<void> {
        await model.dispose()
      }
    }

    extractor = embedder
    emitProgress('ready', 100, 'Model ready')
    logger.info('Embedding model ready')
    return embedder
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      extractor = null
      emitProgress('error', 0, `Error: ${message}`)
      logger.error('Failed to load embedding model', { message })
      throw error
    })
    .finally(() => {
      loadPromise = null
    })

  return loadPromise
}

/**
 * Matryoshka truncation: keep the first {@link EMBEDDING_DIMENSION} dims of the
 * normalized 768d vector and L2 re-normalize them, as the model card specifies.
 */
export function truncateEmbedding(full: ArrayLike<number>): Float32Array {
  if (full.length < EMBEDDING_DIMENSION) {
    throw new Error(`Unexpected dimension: ${full.length} (expected >= ${EMBEDDING_DIMENSION})`)
  }
  const out = new Float32Array(EMBEDDING_DIMENSION)
  let norm = 0
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    out[i] = full[i]
    norm += full[i] * full[i]
  }
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error('Embedding is not finite')
  }
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) out[i] /= norm
  return out
}

async function handleLoadModel(
  message: Extract<EmbeddingMainToWorkerMessage, { type: 'load-model' }>
): Promise<void> {
  try {
    await loadEmbeddingPipeline()
    parentPort.postMessage({
      type: 'load-model-result',
      requestId: message.requestId
    } satisfies EmbeddingWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies EmbeddingWorkerToMainMessage)
  }
}

async function handleEmbed(
  message: Extract<EmbeddingMainToWorkerMessage, { type: 'embed' }>
): Promise<void> {
  try {
    const embedder = await loadEmbeddingPipeline()
    const embedding = Array.from(
      await embedder.embed(message.text.substring(0, MAX_EMBEDDING_INPUT_LENGTH))
    )

    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(`Unexpected dimension: ${embedding.length} (expected ${EMBEDDING_DIMENSION})`)
    }

    parentPort.postMessage({
      type: 'embed-result',
      requestId: message.requestId,
      embedding
    } satisfies EmbeddingWorkerToMainMessage)
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    parentPort.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: failure
    } satisfies EmbeddingWorkerToMainMessage)
  }
}

let shuttingDown = false

/**
 * Free the onnxruntime sessions BEFORE this process unwinds.
 *
 * A bare `process.exit(0)` here skipped JS cleanup and ran onnxruntime's native
 * static destructors with sessions still live, which aborts (SIGABRT, exit 6).
 * The worker's own exit was clean, so the bridge recorded `graceful_stop` and
 * Electron then reported a SEPARATE `child-process-gone` for the abort — the
 * shape behind 70% of macOS installs on #1990.
 *
 * Dropping the last 'message' listener is what lets this process end on its own:
 * Electron's ParentPort pauses itself on `removeListener`, releasing the handle
 * that keeps the loop alive. The timer bounds that — unref'd so it cannot itself
 * hold the loop open, and left armed after disposal because a native runtime
 * with lingering threads is exactly the case it exists for.
 */
async function handleShutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  const fallback = setTimeout(() => {
    logger.warn('Embedding worker did not drain after disposal; exiting')
    process.exit(0)
  }, SHUTDOWN_TIMEOUT_MS)
  if (typeof fallback.unref === 'function') {
    fallback.unref()
  }

  parentPort.off('message', onMessage)

  const disposable = extractor
  extractor = null

  try {
    await disposable?.dispose()
  } catch (error) {
    logger.error('Failed to dispose embedding pipeline', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

function onMessage(event: { data: unknown }): void {
  const message = event.data as EmbeddingMainToWorkerMessage

  switch (message.type) {
    case 'load-model':
      void handleLoadModel(message)
      break
    case 'embed':
      void handleEmbed(message)
      break
    case 'shutdown':
      void handleShutdown()
  }
}

parentPort.on('message', onMessage)

process.on('uncaughtException', (error) => {
  logger.error('Uncaught embedding worker error', {
    message: error instanceof Error ? error.message : String(error)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled embedding worker rejection', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

parentPort.postMessage({ type: 'ready' } satisfies EmbeddingWorkerToMainMessage)
