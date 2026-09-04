import { createLogger } from './logger'
import { installWorkerLogForwarding } from './log-forward'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL_REPO,
  transformersCacheDir
} from './embeddings-constants'
import type {
  EmbeddingMainToWorkerMessage,
  EmbeddingProgressPhase,
  EmbeddingWorkerToMainMessage
} from './embedding-model-protocol'

const logger = createLogger('Embeddings:Worker')

const MAX_CONTENT_LENGTH = 2000

/**
 * Ceiling on the orderly teardown below. Comfortably under the main process's
 * SHUTDOWN_TIMEOUT_MS (3s, embeddings.ts), so a wedged disposal still exits on
 * its own terms rather than being force-killed and reported as a teardown death.
 */
const SHUTDOWN_TIMEOUT_MS = 1_500

interface ModelProgress {
  status: string
  progress?: number
}

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('embedding-worker.ts must be run as an Electron utility process')
}

installWorkerLogForwarding('Embeddings')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadPromise: Promise<any> | null = null

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
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = getTransformersCacheDir()

    extractor = await pipeline('feature-extraction', EMBEDDING_MODEL_REPO, {
      dtype: 'fp32',
      progress_callback: (progress: ModelProgress) => {
        if (progress.status === 'progress') {
          const pct = Math.round(progress.progress ?? 0)
          emitProgress('downloading', pct, `Downloading model: ${pct}%`)
          return
        }

        if (progress.status === 'done') {
          emitProgress('loading', 95, 'Finalizing model...')
        }
      }
    })

    emitProgress('ready', 100, 'Model ready')
    logger.info('Embedding model ready')
    return extractor
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
    const pipeline = await loadEmbeddingPipeline()
    const output = (await pipeline(message.text.substring(0, MAX_CONTENT_LENGTH), {
      pooling: 'mean',
      normalize: true
    })) as { data: ArrayLike<number> }
    const embedding = Array.from(output.data)

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
    await disposable?.dispose?.()
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
