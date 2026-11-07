/**
 * Local Embedding Service
 *
 * Coordinates local text embeddings through an Electron utility process.
 *
 * Model is downloaded on first use (~210MB: ~175MB q4 weights plus the
 * tokenizer) and cached in app data directory.
 *
 * @module main/lib/embeddings
 */

import { app, utilityProcess } from 'electron'
import path from 'path'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import type {
  EmbeddingEncoderModality,
  EmbeddingMainToWorkerMessage,
  EmbeddingProgressMessage,
  EmbeddingProgressPhase,
  EmbeddingWorkerToMainMessage,
  ImageEmbedder,
  ImageEmbedOptions
} from './embedding-model-protocol'
import { EMBEDDING_DIMENSION } from './embeddings-constants'
import {
  isInformationalWorkerStderr,
  formatWorkerStderrTail,
  probeEncoderCache,
  probeModelCache,
  STDERR_TAIL_LIMIT,
  type ModelCacheState
} from './embeddings-worker-stderr'
import { MAX_EMBEDDING_INPUT_LENGTH } from './embedding-input'
import { createLogger } from './logger'
import { lowerProcessPriority } from './low-priority'
import { broadcastToAllWindows } from './window-broadcast'
import { isChildProcessFault, trackMainLog } from '../telemetry/diagnostics'
import { getLogShip } from '../telemetry/log-ship'
import { shouldEmitThrottled } from '../telemetry/throttle'

const logger = createLogger('Embeddings')

/**
 * Where the worker was in its lifecycle when it died. This is the discriminator
 * production is missing: an `idle_shutdown` death costs the user nothing (the
 * embedding was already delivered), while `in_flight` means they silently lost
 * semantic-search indexing for that note.
 */
export type WorkerExitPhase = 'starting' | 'in_flight' | 'idle_shutdown' | 'idle'

/**
 * How the bridge stopped tracking a worker. `live` means it still owns it;
 * everything else is a worker it has already let go of, which is the state
 * every production crash report has arrived in.
 */
export type WorkerRelease =
  | 'live'
  | 'teardown'
  | 'start_timeout'
  | 'request_timeout'
  | 'fatal_error'
  | 'exit'
  | 'graceful_stop'

/** Where an on-demand encoder stands in a worker: never asked for, loading, or live. */
export type EncoderState = 'off' | 'loading' | 'ready'

/**
 * Everything the main process knows about the worker a `child-process-gone`
 * report belongs to. Every field is a number, a bounded enum, or output the
 * caller redacts — no user content.
 */
export interface EmbeddingWorkerCrashContext {
  phase: WorkerExitPhase
  /** OS pid, so two reports can be tied to one fork (or told apart). */
  pid?: number
  /** ms between the fork and this report. Separates "died loading" from "died after running fine". */
  uptimeMs: number
  release: WorkerRelease
  modelCache: ModelCacheState
  /** Size of the cached weights file, when there is one. */
  modelCacheBytes?: number
  /** Image encoder state in this worker. Text-only users stay `off` with `absent` weights. */
  vision: EncoderState
  /** Whether the image encoder weights were on disk when this worker was forked. */
  visionCache: ModelCacheState
  /** Audio encoder state in this worker. Users with no voice memo to embed stay `off`. */
  audio: EncoderState
  /** Whether the audio encoder weights were on disk when this worker was forked. */
  audioCache: ModelCacheState
  /** `reload` when a model load had already failed this session before this fork. */
  load: 'first' | 'reload'
  /** Embedding-worker crash reports seen this session, including this one. */
  crashCount: number
  /** Redacted tail of the worker's own stderr — the abort message, if it wrote one. */
  stderrTail?: string
}

export interface ModelInfo {
  name: string
  dimension: number
  /** Worker state: the model is in memory right now. It goes false when the idle worker exits. */
  loaded: boolean
  /** The weights are on disk, so a load is a cache read, not a download. */
  downloaded: boolean
  loading: boolean
  error: string | null
}

// ============================================================================
// Constants
// ============================================================================

/** Model to use for embeddings */
const MODEL_NAME = 'EmbeddingGemma 2'

export { EMBEDDING_DIMENSION } from './embeddings-constants'

/** Minimum content length to generate embedding */
const MIN_CONTENT_LENGTH = 10

/**
 * The `serviceName` fork option, which is also what Electron reports as
 * `details.name` on `app.on('child-process-gone')` — the only channel that
 * actually observes a native worker crash. Shared so the two cannot drift.
 */
const WORKER_SERVICE_NAME = 'Embeddings'

/**
 * Covers the first-run download inside `load-model`: ~210MB at 2.5 Mbps is
 * ~11 minutes. Five minutes was sized for the 23MB MiniLM.
 */
const REQUEST_TIMEOUT_MS = 15 * 60_000
const START_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const IDLE_SHUTDOWN_MS = 30_000

/**
 * Model-load retry policy (#840).
 *
 * A failed load is almost always the ~210MB download failing (offline, proxy,
 * blocked CDN), so it IS worth retrying — one prod install would have recovered
 * on its own. But it must be retried on a widening schedule: that same install
 * re-attempted the download 48 times in 10 minutes, and every attempt costs a
 * worker fork plus two error lines in the log feed.
 *
 * 60s → 2m → 4m → 8m, then stop for the session. `resetEmbeddingModelFailure()`
 * (AI re-enable / manual load / reindex) always bypasses this — an explicit user
 * retry should never have to wait out a backoff.
 */
const LOAD_RETRY_BASE_DELAY_MS = 60_000
const MAX_CONSECUTIVE_LOAD_FAILURES = 5

/**
 * How long a released worker stays attributable. `child-process-gone` is
 * dispatched by the browser process as soon as it reaps the child, so a report
 * that has not arrived within a minute of the bridge letting go is not about
 * that worker. Long enough to cover the 10s start timeout plus scheduling slack,
 * short enough that a later, unrelated crash cannot inherit a stale record.
 */
const LAST_WORKER_TTL_MS = 60_000

// ============================================================================
// Helper Functions
// ============================================================================

type PendingRequest = {
  resolve: (value: EmbeddingWorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WorkerRequest = Extract<EmbeddingMainToWorkerMessage, { requestId: string }>

/** Transport ownership and diagnostics belong to the same fork. */
type WorkerGeneration = {
  process: ReturnType<typeof utilityProcess.fork>
  readiness: PromiseWithResolvers<void>
  startTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  pendingRequests: Map<string, PendingRequest>
  activeRequests: Map<string, WorkerRequest['type']>
  stopping: boolean
  stopPromise: Promise<void> | null
  loadPromise: Promise<boolean> | null
  forceKilled: boolean
  pid?: number
  forkedAt: number
  ready: boolean
  modelCache: ModelCacheState
  modelCacheBytes?: number
  vision: EncoderState
  visionCache: ModelCacheState
  audio: EncoderState
  audioCache: ModelCacheState
  load: 'first' | 'reload'
  /** Bounded tail of everything this worker wrote to stderr. */
  stderrTail: string
  /** Phase at the moment the bridge released it; null while it is still live. */
  releasePhase: WorkerExitPhase | null
}

/**
 * Emit model loading progress to all renderer windows
 */
function emitProgress(
  phase: EmbeddingProgressPhase,
  progress: number,
  status: string,
  modality?: EmbeddingEncoderModality
): void {
  broadcastToAllWindows(SettingsChannels.events.EMBEDDING_PROGRESS, {
    phase,
    progress,
    status,
    ...(modality ? { modality } : {})
  })
}

interface EncoderBreaker {
  failures: number
  retryNotBefore: number
}

class EmbeddingModelBridge {
  private requestCounter = 0
  private loaded = false
  private loading = false
  // Circuit breaker: latched when model loads keep failing (download stall, worker
  // crash, timeout). While set, loadModel() and embed() short-circuit instead of
  // re-forking the worker and re-attempting the ~210MB download per note — the loop
  // that made vault-open hang indefinitely (#803). Cleared on a successful load, on
  // reset(), and when AI is re-enabled (resetEmbeddingModelFailure).
  private loadFailed = false
  // Consecutive failures feeding the retry backoff. Latching on the FIRST failure
  // (as this breaker originally did) meant a 5-second network blip silently killed
  // semantic indexing for the rest of the app session, so instead the failures are
  // counted and spaced out, and only the Nth latches for good (#840).
  private consecutiveFailures = 0
  // Worker deaths during embed() since the last delivered embedding. Callers run
  // loadModel() before every embed, and a fresh worker loads fine and then aborts
  // on inference, so a load success must not erase these or the breaker never
  // opens (#3407). Only a delivered embedding or an explicit reset clears them.
  private embedFailures = 0
  // Epoch ms before which no load may be attempted. 0 = retry allowed now.
  private retryNotBefore = 0
  // Each on-demand encoder has its own breaker, fed only by its own failures: a
  // ~109MB (vision) or ~189MB (audio) download that keeps failing, or a file that
  // crashes the worker, must not stop text indexing (which shares the worker but
  // not this state).
  private encoderBreakers: Record<EmbeddingEncoderModality, EncoderBreaker> = {
    vision: { failures: 0, retryNotBefore: 0 },
    audio: { failures: 0, retryNotBefore: 0 }
  }
  private error: string | null = null
  private worker: WorkerGeneration | null = null
  // Retain the released fork for delayed child-process-gone reports. The TTL
  // prevents a later unrelated crash from inheriting this generation's context.
  private lastWorker: (WorkerGeneration & { release: WorkerRelease; releasedAt: number }) | null =
    null
  // Crash reports attributed to an embedding worker this session. A burst on one
  // install and a slow drip across many are different bugs; today they are only
  // separable with post-hoc SQL.
  private crashCount = 0

  get isLoaded(): boolean {
    return this.loaded
  }

  get isLoading(): boolean {
    return this.loading
  }

  get info(): ModelInfo {
    return {
      name: MODEL_NAME,
      dimension: EMBEDDING_DIMENSION,
      loaded: this.loaded,
      downloaded: this.loaded || probeModelCache(app.getPath('userData')).state === 'present',
      loading: this.loading,
      error: this.error
    }
  }

  loadModel(): Promise<boolean> {
    if (this.isBreakerOpen()) return Promise.resolve(false)
    try {
      const generation = this.start()
      if (!this.isActive(generation)) return Promise.resolve(false)
      if (generation.loadPromise) return generation.loadPromise
      const attempt: Promise<boolean> = this.loadGeneration(generation).finally(() => {
        if (generation.loadPromise === attempt) generation.loadPromise = null
      })
      generation.loadPromise = attempt
      return attempt
    } catch (error) {
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.recordFailure()
      return Promise.resolve(false)
    }
  }

  private async loadGeneration(generation: WorkerGeneration): Promise<boolean> {
    try {
      this.loading = !this.loaded
      const response = await this.sendRequest(generation, {
        type: 'load-model',
        requestId: this.nextRequestId()
      })
      if (!this.isActive(generation)) return false

      if (response.type === 'error') {
        this.error = response.error
        this.loading = false
        this.recordFailure()
        return false
      }

      if (response.type !== 'load-model-result') {
        this.error = `Unexpected response type: ${response.type}`
        this.loading = false
        this.recordFailure()
        return false
      }

      this.loaded = true
      this.loading = false
      this.error = null
      if (this.embedFailures === 0) this.recordSuccess()
      return true
    } catch (error) {
      if (!this.isActive(generation)) return false
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.recordFailure()
      return false
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    // Belt-and-suspenders for the same loop: callers reach embeddings through
    // isModelLoaded() -> initEmbeddingModel(), but nothing forces them to, and the
    // worker re-drives the download inside handleEmbed. Without this an embed()
    // caller that skips that guard reopens the retry loop the breaker exists to close.
    if (this.isBreakerOpen()) {
      return null
    }

    // A failure on a call that had to (re)load the model is a load failure and
    // feeds the backoff. A failure with the model already loaded is a crash or an
    // inference fault — leave the breaker alone so the next note simply re-forks.
    const wasLoaded = this.loaded

    let generation: WorkerGeneration | null = null
    try {
      generation = this.start()
      if (!this.isActive(generation)) return null
      this.loading = !this.loaded
      const response = await this.sendRequest(generation, {
        type: 'embed',
        requestId: this.nextRequestId(),
        text: text.substring(0, MAX_EMBEDDING_INPUT_LENGTH)
      })
      if (!this.isActive(generation)) return null

      if (response.type === 'error') {
        this.error = response.error
        this.loading = false
        if (!wasLoaded) {
          this.recordFailure()
        }
        logger.warn('Embedding worker failed:', response.error)
        return null
      }

      if (response.type !== 'embed-result') {
        this.error = `Unexpected response type: ${response.type}`
        this.loading = false
        return null
      }

      const embedding = new Float32Array(response.embedding)
      if (embedding.length !== EMBEDDING_DIMENSION) {
        logger.error(`Unexpected dimension: ${embedding.length} (expected ${EMBEDDING_DIMENSION})`)
        return null
      }

      this.loaded = true
      this.loading = false
      this.error = null
      this.embedFailures = 0
      this.recordSuccess()
      return embedding
    } catch (error) {
      if (generation && !this.isActive(generation)) return null
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.embedFailures += 1
      this.recordFailure()
      this.reportEmbeddingFailure(error)
      return null
    }
  }

  /**
   * Embed an image file with the vision encoder. The encoder downloads and
   * loads on the first call only; a text-only vault never reaches this.
   */
  embedImage(image: Uint8Array, options: ImageEmbedOptions = {}): Promise<Float32Array | null> {
    return this.embedWithEncoder('vision', (requestId) => ({
      type: 'embed-image',
      requestId,
      image,
      ...options
    }))
  }

  /**
   * Embed one window of mono 16 kHz audio with the audio encoder. Like the
   * vision encoder it downloads and loads on the first call only.
   */
  embedAudio(audio: Float32Array): Promise<Float32Array | null> {
    return this.embedWithEncoder('audio', (requestId) => ({
      type: 'embed-audio',
      requestId,
      audio
    }))
  }

  private async embedWithEncoder(
    modality: EmbeddingEncoderModality,
    message: (requestId: string) => WorkerRequest
  ): Promise<Float32Array | null> {
    const breaker = this.encoderBreakers[modality]
    if (this.isBreakerOpen() || Date.now() < breaker.retryNotBefore) return null

    let generation: WorkerGeneration | null = null
    try {
      generation = this.start()
      if (!this.isActive(generation)) return null
      if (generation[modality] === 'off') generation[modality] = 'loading'
      const response = await this.sendRequest(generation, message(this.nextRequestId()))
      if (!this.isActive(generation)) return null

      if (response.type === 'error') {
        this.recordEncoderFailure(modality, response.error)
        return null
      }
      if (response.type !== 'embed-result') {
        this.recordEncoderFailure(modality, `Unexpected response type: ${response.type}`)
        return null
      }

      const embedding = new Float32Array(response.embedding)
      if (embedding.length !== EMBEDDING_DIMENSION) {
        this.recordEncoderFailure(modality, `Unexpected dimension: ${embedding.length}`)
        return null
      }

      generation[modality] = 'ready'
      breaker.failures = 0
      breaker.retryNotBefore = 0
      return embedding
    } catch (error) {
      if (generation && !this.isActive(generation)) return null
      this.recordEncoderFailure(modality, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /**
   * Abort an encoder download. The worker is killed (transformers.js has no
   * abort for a fetch in flight); its cache writes are temp-then-rename, so
   * nothing torn is left behind, and the next text embed forks a fresh worker.
   */
  cancelEncoderLoad(modality: EmbeddingEncoderModality): void {
    if (this.worker?.[modality] !== 'loading') return
    this.reset()
  }

  private recordEncoderFailure(modality: EmbeddingEncoderModality, message: string): void {
    const breaker = this.encoderBreakers[modality]
    breaker.failures += 1
    const delay = LOAD_RETRY_BASE_DELAY_MS * 2 ** Math.min(breaker.failures - 1, 3)
    breaker.retryNotBefore = Date.now() + delay
    this.error = message
    logger.warn(`${modality} embedding failed — backing off before retry`, {
      attempt: breaker.failures,
      retryInMs: delay,
      error: message
    })
    if (shouldEmitThrottled(`embeddings:${modality}_embed_failed`)) {
      trackMainLog('error', {
        scope: 'Embeddings',
        action: `${modality}_embed_failed`,
        errorCode: modality === 'vision' ? 'ImageEmbedFailed' : 'AudioEmbedFailed'
      })
    }
  }

  async stop(): Promise<void> {
    const generation = this.worker
    if (!generation) return
    if (generation.stopPromise) return generation.stopPromise

    generation.stopping = true
    this.clearIdleShutdown(generation)
    clearTimeout(generation.startTimer ?? undefined)
    const error = new Error('Embedding utility stopping')
    generation.readiness.reject(error)
    this.rejectAll(generation, error)
    this.loaded = false
    this.loading = false

    generation.stopPromise = new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout)
        generation.process.off('exit', finish)
        this.releaseWorker(generation, 'teardown', 'idle_shutdown')
        resolve()
      }
      const timeout = setTimeout(() => {
        generation.forceKilled = true
        this.releaseWorker(generation, 'teardown', 'idle_shutdown')
        generation.process.kill()
        finish()
      }, SHUTDOWN_TIMEOUT_MS)
      generation.process.once('exit', finish)
      try {
        generation.process.postMessage({ type: 'shutdown' } satisfies EmbeddingMainToWorkerMessage)
      } catch (shutdownError) {
        logger.warn('Embedding utility shutdown failed', { error: shutdownError })
        generation.forceKilled = true
        this.releaseWorker(generation, 'teardown', 'idle_shutdown')
        generation.process.kill()
        finish()
      }
    })
    await generation.stopPromise
  }

  reset(): void {
    const generation = this.worker
    if (generation) {
      generation.forceKilled = true
      this.releaseWorker(generation, 'teardown', 'idle_shutdown')
      generation.process.kill()
    } else {
      this.lastWorker = null
    }
    this.loaded = false
    this.loading = false
    this.clearLoadFailure()
    this.error = null
  }

  clearLoadFailure(): void {
    this.loadFailed = false
    this.consecutiveFailures = 0
    this.embedFailures = 0
    this.retryNotBefore = 0
    for (const breaker of Object.values(this.encoderBreakers)) {
      breaker.failures = 0
      breaker.retryNotBefore = 0
    }
  }

  /** True while a load must not be attempted: backing off, or latched for good. */
  private isBreakerOpen(): boolean {
    return this.loadFailed || Date.now() < this.retryNotBefore
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_LOAD_FAILURES) {
      this.loadFailed = true
      this.retryNotBefore = 0
      logger.error('Embedding model failed repeatedly — giving up until restart', {
        attempts: this.consecutiveFailures,
        error: this.error
      })
      return
    }

    const delay = LOAD_RETRY_BASE_DELAY_MS * 2 ** (this.consecutiveFailures - 1)
    this.retryNotBefore = Date.now() + delay
    logger.warn('Embedding model failed — backing off before retry', {
      attempt: this.consecutiveFailures,
      retryInMs: delay,
      error: this.error
    })
  }

  private recordSuccess(): void {
    this.loadFailed = false
    this.consecutiveFailures = 0
    this.retryNotBefore = 0
  }

  private isActive(generation: WorkerGeneration): boolean {
    return this.worker === generation && !generation.stopping
  }

  private start(): WorkerGeneration {
    if (this.worker) {
      if (!this.worker.stopping) {
        this.clearIdleShutdown(this.worker)
        return this.worker
      }
      // Re-enable may arrive before the old bounded shutdown finishes.
      this.releaseWorker(this.worker, 'teardown', 'idle_shutdown')
    }

    const workerPath = path.join(__dirname, 'embedding-worker.js')
    const userDataPath = app.getPath('userData')
    const modelCache = probeModelCache(userDataPath)
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: WORKER_SERVICE_NAME,
      stdio: 'pipe',
      env: { ...process.env, MEMRY_USER_DATA_PATH: userDataPath },
      allowLoadingUnsignedLibraries: process.platform === 'darwin'
    })
    child.once('spawn', () => lowerProcessPriority(child.pid))
    const generation: WorkerGeneration = {
      process: child,
      readiness: Promise.withResolvers<void>(),
      startTimer: null,
      idleTimer: null,
      pendingRequests: new Map(),
      activeRequests: new Map(),
      stopping: false,
      stopPromise: null,
      loadPromise: null,
      forceKilled: false,
      pid: child.pid,
      forkedAt: Date.now(),
      ready: false,
      modelCache: modelCache.state,
      modelCacheBytes: modelCache.bytes,
      vision: 'off',
      visionCache: probeEncoderCache(userDataPath, 'vision'),
      audio: 'off',
      audioCache: probeEncoderCache(userDataPath, 'audio'),
      load: this.consecutiveFailures > 0 ? 'reload' : 'first',
      stderrTail: '',
      releasePhase: null
    }
    this.worker = generation
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) logger.info(`Embedding utility stdout: ${output}`)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (!output) return
      generation.stderrTail = `${generation.stderrTail}${output}\n`.slice(-STDERR_TAIL_LIMIT)
      if (isInformationalWorkerStderr(output)) {
        logger.debug(`Embedding utility stderr: ${output}`)
      } else {
        logger.error(`Embedding utility stderr: ${output}`)
      }
    })
    generation.startTimer = setTimeout(() => {
      if (!this.isActive(generation)) return
      const error = new Error('Embedding utility failed to start within timeout')
      logger.error('Embedding utility start timeout', { workerPath, pid: child.pid })
      this.failProcess(generation, error, 'start_timeout')
    }, START_TIMEOUT_MS)
    this.setupProcessHandlers(generation)
    return generation
  }

  private setupProcessHandlers(generation: WorkerGeneration): void {
    const child = generation.process
    child.on('message', (message: EmbeddingWorkerToMainMessage) => {
      if (message.type === 'log') {
        getLogShip()?.ingestForwarded(message.record, 'Embeddings')
        return
      }
      if (!this.isActive(generation)) return
      if (message.type === 'ready') {
        clearTimeout(generation.startTimer ?? undefined)
        generation.startTimer = null
        generation.ready = true
        generation.readiness.resolve()
        logger.info('Embedding utility ready')
        return
      }
      if (!generation.ready) return
      if (message.type === 'progress') {
        this.applyProgress(message)
        return
      }
      if ('requestId' in message) {
        const pending = generation.pendingRequests.get(message.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        generation.pendingRequests.delete(message.requestId)
        if (message.type === 'error') {
          this.error = message.error
          this.loading = false
        }
        this.scheduleIdleShutdown(generation)
        pending.resolve(message)
      }
    })
    child.on('error', (type: string, location: string, report: string) => {
      if (!this.isActive(generation)) return
      const error = new Error(`Embedding utility fatal error: ${type} at ${location}`)
      logger.error('Embedding utility fatal error', { type, location, report })
      this.failProcess(generation, error, 'fatal_error')
    })
    child.once('exit', (code: number) => {
      const phase = generation.releasePhase ?? this.currentPhase(generation)
      if (this.worker !== generation) {
        // Teardown telemetry belongs to the old fork, never to its replacement.
        if (phase === 'idle_shutdown' && (generation.forceKilled || code !== 0)) {
          this.trackWorkerExit(phase, code)
        }
        return
      }
      if (generation.stopping && code === 0) {
        this.releaseWorker(generation, 'graceful_stop', phase)
        return
      }
      this.trackWorkerExit(phase, code)
      this.failProcess(
        generation,
        new Error(`Embedding utility exited unexpectedly (code ${code})`),
        'exit'
      )
    })
  }

  private currentPhase(generation: WorkerGeneration): WorkerExitPhase {
    if (generation.stopping) return 'idle_shutdown'
    if (generation.pendingRequests.size > 0) return 'in_flight'
    return generation.ready ? 'idle' : 'starting'
  }

  /**
   * Deliberately NOT throttled: the crash cadence (one install saw ~15/hour at
   * 30s-2min intervals) is itself the diagnostic signal, and losing it would
   * make the rate look lower than it is.
   */
  private trackWorkerExit(phase: WorkerExitPhase, code: number): void {
    trackMainLog('error', {
      scope: 'Embeddings',
      action: `worker_exit_${phase}`,
      errorCode: 'EmbeddingWorkerExit',
      metrics: { value: code }
    })
  }

  private applyProgress(message: EmbeddingProgressMessage): void {
    // Image-encoder progress is about the upgrade, not the text model: a failed
    // download must not mark the working text model as errored.
    if (message.modality) {
      if (message.phase === 'ready' && this.worker) this.worker[message.modality] = 'ready'
      emitProgress(message.phase, message.progress, message.status, message.modality)
      return
    }

    if (message.phase === 'ready') {
      this.loaded = true
      this.loading = false
      this.error = null
    } else if (message.phase === 'error') {
      this.loaded = false
      this.loading = false
      this.error = message.status
    } else {
      this.loading = true
      this.error = null
    }

    emitProgress(message.phase, message.progress, message.status)
  }

  private async sendRequest(
    generation: WorkerGeneration,
    message: WorkerRequest
  ): Promise<EmbeddingWorkerToMainMessage> {
    generation.activeRequests.set(message.requestId, message.type)
    try {
      await generation.readiness.promise
      if (!this.isActive(generation)) throw new Error('Embedding utility generation retired')
      this.clearIdleShutdown(generation)
      return await new Promise<EmbeddingWorkerToMainMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.failProcess(
            generation,
            new Error(`Embedding request timed out: ${message.type}`),
            'request_timeout'
          )
        }, REQUEST_TIMEOUT_MS)
        generation.pendingRequests.set(message.requestId, { resolve, reject, timer })
        try {
          generation.process.postMessage(message)
        } catch (error) {
          this.failProcess(
            generation,
            error instanceof Error ? error : new Error(String(error)),
            'fatal_error'
          )
        }
      })
    } finally {
      generation.activeRequests.delete(message.requestId)
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `embedding_${this.requestCounter}_${Date.now()}`
  }

  private failProcess(generation: WorkerGeneration, error: Error, release: WorkerRelease): void {
    if (!this.isActive(generation)) return
    const phase = this.currentPhase(generation)
    const requests = new Set(generation.activeRequests.values())
    this.error = error.message
    // A terminal fault belongs to the fork, not to each caller rejected by it.
    if (requests.has('embed')) {
      this.embedFailures += 1
      this.reportEmbeddingFailure(error)
    }
    if (requests.has('load-model') || requests.has('embed')) this.recordFailure()
    if (requests.has('embed-image')) this.recordEncoderFailure('vision', error.message)
    if (requests.has('embed-audio')) this.recordEncoderFailure('audio', error.message)
    this.releaseWorker(generation, release, phase)
    if (release !== 'exit') generation.process.kill()
  }

  private reportEmbeddingFailure(error: unknown): void {
    logger.error('Generation failed:', error)
    if (shouldEmitThrottled('embeddings:embed_failed')) {
      trackMainLog('error', {
        scope: 'Embeddings',
        action: 'embed_failed',
        errorCode: error instanceof Error && error.name ? error.name : 'UnknownError'
      })
    }
  }

  private releaseWorker(
    generation: WorkerGeneration,
    release: WorkerRelease,
    phase: WorkerExitPhase
  ): void {
    generation.stopping = true
    generation.loadPromise = null
    generation.releasePhase ??= phase
    clearTimeout(generation.startTimer ?? undefined)
    generation.startTimer = null
    this.clearIdleShutdown(generation)
    const error = new Error('Embedding utility generation retired')
    generation.readiness.reject(error)
    this.rejectAll(generation, error)
    if (this.worker !== generation) return
    this.lastWorker = { ...generation, release, releasedAt: Date.now() }
    this.worker = null
    this.loaded = false
    this.loading = false
  }

  /**
   * The worker a `child-process-gone` report belongs to, with everything the
   * main process knows about it.
   *
   * Reads the live generation, then its retained release record. A delayed exit
   * from that fork cannot change a newer worker's phase or transport ownership.
   */
  crashContext(): EmbeddingWorkerCrashContext | null {
    const now = Date.now()
    if (this.worker) {
      const live = this.worker
      return {
        phase: this.currentPhase(live),
        release: live.stopping ? 'teardown' : 'live',
        uptimeMs: Math.max(0, now - live.forkedAt),
        ...this.describeGeneration(live)
      }
    }

    const last = this.lastWorker
    if (!last || now - last.releasedAt > LAST_WORKER_TTL_MS) return null
    return {
      phase: last.releasePhase ?? 'idle',
      release: last.release,
      uptimeMs: Math.max(0, now - last.forkedAt),
      ...this.describeGeneration(last)
    }
  }

  private describeGeneration(generation: WorkerGeneration): Omit<
    EmbeddingWorkerCrashContext,
    'phase' | 'release' | 'uptimeMs' | 'crashCount'
  > & {
    crashCount: number
  } {
    return {
      pid: generation.pid,
      modelCache: generation.modelCache,
      modelCacheBytes: generation.modelCacheBytes,
      vision: generation.vision,
      visionCache: generation.visionCache,
      audio: generation.audio,
      audioCache: generation.audioCache,
      load: generation.load,
      crashCount: this.crashCount,
      stderrTail: formatWorkerStderrTail(generation.stderrTail)
    }
  }

  /** Count a crash report before it is described, so the event includes itself. */
  countCrashReport(): void {
    this.crashCount += 1
  }

  private rejectAll(generation: WorkerGeneration, error: Error): void {
    for (const pending of generation.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    generation.pendingRequests.clear()
  }

  private scheduleIdleShutdown(generation: WorkerGeneration): void {
    this.clearIdleShutdown(generation)
    if (!this.isActive(generation) || generation.pendingRequests.size > 0) return
    generation.idleTimer = setTimeout(() => {
      generation.idleTimer = null
      if (!this.isActive(generation) || generation.activeRequests.size > 0) return
      void this.stop().catch((error: unknown) => {
        logger.warn('Embedding utility idle shutdown failed', { error })
      })
    }, IDLE_SHUTDOWN_MS)
  }

  private clearIdleShutdown(generation: WorkerGeneration): void {
    if (generation.idleTimer) clearTimeout(generation.idleTimer)
    generation.idleTimer = null
  }
}

const bridge = new EmbeddingModelBridge()

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the embedding model.
 * Downloads the model on first use (~210MB).
 *
 * @returns true if model loaded successfully
 */
export async function initEmbeddingModel(): Promise<boolean> {
  return bridge.loadModel()
}

/**
 * Generate embedding for text using local model.
 *
 * @param text - Text to generate embedding for
 * @returns Float32Array embedding or null on error
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  // Validate input
  if (!text || text.trim().length < MIN_CONTENT_LENGTH) {
    return null
  }

  return bridge.embed(text)
}

/**
 * Check if the embedding model is loaded
 */
export function isModelLoaded(): boolean {
  return bridge.isLoaded
}

/**
 * Check if the model is currently loading
 */
export function isModelLoading(): boolean {
  return bridge.isLoading
}

/**
 * Get model information
 */
export function getModelInfo(): ModelInfo {
  return bridge.info
}

/**
 * Unload the model to free memory
 */
export function unloadModel(): void {
  bridge.reset()
  logger.info('Model unloaded')
}

/**
 * Embed an image file (jpeg, png, webp, ...) into the same space as text. The
 * vision encoder (~109MB) downloads on the first call, so callers must gate on
 * the user's image-embedding setting first (see image-embedding.ts).
 *
 * @returns Float32Array embedding, or null on error
 */
export const generateImageEmbedding: ImageEmbedder = async (image, options) => {
  if (image.byteLength === 0) return null
  return bridge.embedImage(image, options)
}

/** Abort an in-flight image encoder download. No-op unless one is loading. */
export function cancelImageModelLoad(): void {
  bridge.cancelEncoderLoad('vision')
}

/**
 * Embed one window of mono 16 kHz audio into the same space as text. The audio
 * encoder (~189MB) downloads on the first call, so callers must gate on the
 * user's setting first (see audio-embedding.ts).
 *
 * @returns Float32Array embedding, or null on error
 */
export async function generateAudioEmbedding(audio: Float32Array): Promise<Float32Array | null> {
  if (audio.length === 0) return null
  return bridge.embedAudio(audio)
}

/** Abort an in-flight audio encoder download. No-op unless one is loading. */
export function cancelAudioModelLoad(): void {
  bridge.cancelEncoderLoad('audio')
}

export async function stopEmbeddingModel(): Promise<void> {
  await bridge.stop()
}

/**
 * Clear the model-load circuit breaker so the next embedding attempt retries a
 * fresh load. Call when the user re-enables AI after a failed/stalled load (#803).
 */
export function resetEmbeddingModelFailure(): void {
  bridge.clearLoadFailure()
}

/**
 * What the main process knows about the worker a `child-process-gone` report is
 * about: its lifecycle phase, pid, uptime, the model-cache state it was forked
 * with, how the bridge last saw it, and the tail of its stderr.
 *
 * This is the ONLY report a native worker crash produces. The worker's own
 * 'exit' event does not fire for one — a SIGABRT out of the model runtime is
 * neither a graceful exit nor a V8 fatal error — so the bridge never learns its
 * worker died, and production proved it: across 107 consecutive
 * `Utility:crashed:Embeddings` events, `worker_exit_<phase>` emitted zero and so
 * did `embed_failed`.
 *
 * Retirement retains a bounded diagnostic record after the worker is detached,
 * so a delayed native-crash report can still identify the released generation.
 *
 * Returns null when the report is not about our embedding worker, when the
 * reason is lifecycle rather than a fault, or when no worker is attributable.
 *
 * @param workerName - `details.name` from `app.on('child-process-gone')`
 * @param reason - `details.reason` from the same report
 */
export function getEmbeddingWorkerCrashContext(
  workerName: string | undefined,
  reason: string
): EmbeddingWorkerCrashContext | null {
  if (workerName !== WORKER_SERVICE_NAME) return null
  // A clean idle-shutdown (or an OS memory-pressure eviction) is lifecycle, not a
  // crash: counting it would make the session crash counter meaningless.
  if (!isChildProcessFault(reason)) return null
  bridge.countCrashReport()
  return bridge.crashContext()
}
