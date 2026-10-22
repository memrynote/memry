import os from 'os'
import { createLogger } from './logger'
import { installWorkerLogForwarding } from './log-forward'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_IMAGE_SOFT_TOKENS,
  EMBEDDING_MODEL_DTYPE,
  EMBEDDING_MODEL_REPO,
  transformersCacheDir
} from './embeddings-constants'
import { MAX_EMBEDDING_INPUT_LENGTH } from './embedding-input'
import type {
  EmbeddingEncoderModality,
  EmbeddingMainToWorkerMessage,
  ImageEmbedOptions,
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

/**
 * onnxruntime takes every core by default, so a vault-wide re-embed pinned the
 * whole machine. Half the cores leaves the rest for the user.
 */
const INFERENCE_THREADS = Math.max(1, Math.floor(os.availableParallelism() / 2))

interface ModelProgress {
  status: string
  file?: string
  loaded?: number
  total?: number
}

interface Embedder {
  embed(text: string): Promise<Float32Array>
  /** Absent on the text-only model, which has no vision session. */
  embedImage?(image: Uint8Array, options?: ImageEmbedOptions): Promise<Float32Array>
  /** Absent unless the audio encoder was requested. */
  embedAudio?(audio: Float32Array): Promise<Float32Array>
  dispose(): Promise<void>
}

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('embedding-worker.ts must be run as an Electron utility process')
}

installWorkerLogForwarding('Embeddings')

let extractor: Embedder | null = null
let loadPromise: Promise<Embedder> | null = null

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

function emitProgress(
  phase: EmbeddingProgressPhase,
  progress: number,
  status: string,
  modality?: EmbeddingEncoderModality
): void {
  parentPort.postMessage({
    type: 'progress',
    phase,
    progress,
    status,
    ...(modality ? { modality } : {})
  } satisfies EmbeddingWorkerToMainMessage)
}

const ENCODER_LABEL = { vision: 'image', audio: 'audio' } as const

/**
 * The text model plus whichever on-demand encoders are asked for. A worker
 * upgrades itself the first time an image or a recording arrives: the model with
 * the extra encoder is built (downloading it once: ~109MB vision, ~189MB audio),
 * keeping any encoder already resident, then the previous model is disposed, so
 * the text graph is never resident twice.
 */
async function loadEmbeddingPipeline(
  need: { vision?: boolean; audio?: boolean } = {}
): Promise<Embedder> {
  for (;;) {
    if (
      extractor &&
      (!need.vision || extractor.embedImage) &&
      (!need.audio || extractor.embedAudio)
    ) {
      return extractor
    }
    if (!loadPromise) break
    await loadPromise
  }

  const withVision = need.vision === true || extractor?.embedImage !== undefined
  const withAudio = need.audio === true || extractor?.embedAudio !== undefined
  const modality: EmbeddingEncoderModality | undefined = need.audio
    ? 'audio'
    : need.vision
      ? 'vision'
      : undefined
  const label = modality ? `${ENCODER_LABEL[modality]} ` : ''
  emitProgress('loading', 0, `Initializing ${label}model...`, modality)

  loadPromise = (async () => {
    const { AutoConfig, AutoModel, AutoProcessor, AutoTokenizer, RawImage, env } =
      await import('@huggingface/transformers')
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
        emitProgress('downloading', pct, `Downloading ${label}model: ${pct}%`, modality)
        return
      }

      if (progress.status === 'done') {
        emitProgress('loading', 95, 'Finalizing model...', modality)
      }
    }

    // EmbeddingGemma 2 is multimodal and transformers.js builds a vision and an
    // audio session whenever the config carries their sections. Text-only
    // clears both, so only the text graph (model_q4.onnx + data) loads and the
    // ~300MB of encoders never download. Loading through AutoModel rather than
    // pipeline() also matters: pipeline() probes the encoder files for its progress totals even
    // when they are never used.
    const config = await AutoConfig.from_pretrained(EMBEDDING_MODEL_REPO, { progress_callback })
    const configSections = config as unknown as Record<string, unknown>
    if (!withVision) configSections.vision_config = null
    if (!withAudio) configSections.audio_config = null

    const [tokenizer, model, processor] = await Promise.all([
      AutoTokenizer.from_pretrained(EMBEDDING_MODEL_REPO, { progress_callback }),
      AutoModel.from_pretrained(EMBEDDING_MODEL_REPO, {
        config,
        dtype: EMBEDDING_MODEL_DTYPE,
        device: 'cpu',
        session_options: { intraOpNumThreads: INFERENCE_THREADS, interOpNumThreads: 1 },
        progress_callback
      }),
      withVision || withAudio
        ? AutoProcessor.from_pretrained(EMBEDDING_MODEL_REPO, { progress_callback })
        : null
    ])
    if (processor && withVision) {
      ;(
        processor as unknown as { image_processor: { max_soft_tokens: number } }
      ).image_processor.max_soft_tokens = EMBEDDING_IMAGE_SOFT_TOKENS
    }

    // `sentence_embedding` is the model's own mean-pooled, projected and
    // L2-normalized 768d output.
    type ModelOutput = { sentence_embedding: { data: ArrayLike<number> } }
    // Runs started before an upgrade swaps this model out finish first:
    // releasing an onnxruntime session under a live run aborts the process.
    const active = new Set<Promise<unknown>>()
    const track = <T>(run: Promise<T>): Promise<T> => {
      active.add(run)
      void run.then(
        () => active.delete(run),
        () => active.delete(run)
      )
      return run
    }
    const embedder: Embedder = {
      embed: (text: string): Promise<Float32Array> =>
        track(
          (async () => {
            const inputs = tokenizer([text], { padding: true, truncation: true })
            const output = (await model(inputs)) as ModelOutput
            return truncateEmbedding(output.sentence_embedding.data)
          })()
        ),
      ...(processor && withAudio
        ? {
            embedAudio: (audio: Float32Array): Promise<Float32Array> =>
              track(
                (async () => {
                  const inputs = await (
                    processor as unknown as (
                      text: null,
                      image: null,
                      audio: Float32Array
                    ) => Promise<Record<string, unknown>>
                  )(null, null, audio)
                  const output = (await model(inputs)) as ModelOutput
                  return truncateEmbedding(output.sentence_embedding.data)
                })()
              )
          }
        : {}),
      ...(processor && withVision
        ? {
            embedImage: (image: Uint8Array, options?: ImageEmbedOptions): Promise<Float32Array> =>
              track(
                (async () => {
                  const raw = await RawImage.fromBlob(new Blob([image as BlobPart]))
                  // Callers embed one image at a time, so setting the budget here
                  // cannot race another image's preprocessing.
                  ;(
                    processor as unknown as { image_processor: { max_soft_tokens: number } }
                  ).image_processor.max_soft_tokens =
                    options?.softTokens ?? EMBEDDING_IMAGE_SOFT_TOKENS
                  const inputs = await (
                    processor as unknown as (
                      text: string | null,
                      image: unknown
                    ) => Promise<Record<string, unknown>>
                  )(options?.text ?? null, raw)
                  const output = (await model(inputs)) as ModelOutput
                  return truncateEmbedding(output.sentence_embedding.data)
                })()
              )
          }
        : {}),
      async dispose(): Promise<void> {
        await Promise.allSettled([...active])
        await model.dispose()
      }
    }

    const previous = extractor
    extractor = embedder
    await previous?.dispose().catch((error: unknown) => {
      logger.warn('Failed to dispose superseded embedding model', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    emitProgress('ready', 100, modality ? `${label}model ready` : 'Model ready', modality)
    logger.info('Embedding model ready', { vision: withVision, audio: withAudio })
    return embedder
  })()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      emitProgress('error', 0, `Error: ${message}`, modality)
      logger.error(modality ? `Failed to load ${label}encoder` : 'Failed to load embedding model', {
        message
      })
      // A failed encoder upgrade leaves the working text model in place.
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

async function handleEmbedImage(
  message: Extract<EmbeddingMainToWorkerMessage, { type: 'embed-image' }>
): Promise<void> {
  try {
    const embedder = await loadEmbeddingPipeline({ vision: true })
    if (!embedder.embedImage) throw new Error('Image encoder is not loaded')
    const embedding = Array.from(
      await embedder.embedImage(message.image, {
        text: message.text,
        softTokens: message.softTokens
      })
    )

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

async function handleEmbedAudio(
  message: Extract<EmbeddingMainToWorkerMessage, { type: 'embed-audio' }>
): Promise<void> {
  try {
    const embedder = await loadEmbeddingPipeline({ audio: true })
    if (!embedder.embedAudio) throw new Error('Audio encoder is not loaded')
    const embedding = Array.from(await embedder.embedAudio(message.audio))

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

  let disposed = false
  const fallback = setTimeout(() => {
    // Disposal finished but native runtime threads still hold the loop open:
    // routine on every idle shutdown (#3280), so info. A disposal that never
    // settled is a real wedge and stays a warning.
    if (disposed) logger.info('Embedding worker exiting after disposal')
    else logger.warn('Embedding worker disposal did not settle; exiting')
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
    disposed = true
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
    case 'embed-image':
      void handleEmbedImage(message)
      break
    case 'embed-audio':
      void handleEmbedAudio(message)
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
