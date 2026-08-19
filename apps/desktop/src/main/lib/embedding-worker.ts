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

parentPort.on('message', (event) => {
  const message = event.data as EmbeddingMainToWorkerMessage

  switch (message.type) {
    case 'load-model':
      void handleLoadModel(message)
      break
    case 'embed':
      void handleEmbed(message)
      break
    case 'shutdown':
      process.exit(0)
  }
})

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
