/**
 * Local Embedding Service
 *
 * Coordinates local text embeddings through an Electron utility process.
 *
 * Model is downloaded on first use (~23MB) and cached in app data directory.
 *
 * @module main/lib/embeddings
 */

import { app, utilityProcess } from 'electron'
import path from 'path'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import type {
  EmbeddingMainToWorkerMessage,
  EmbeddingProgressMessage,
  EmbeddingProgressPhase,
  EmbeddingWorkerToMainMessage
} from './embedding-model-protocol'
import { EMBEDDING_DIMENSION } from './embeddings-constants'
import { createLogger } from './logger'
import { broadcastToAllWindows } from './window-broadcast'
import { trackMainLog } from '../telemetry/diagnostics'
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

export interface ModelInfo {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
}

// ============================================================================
// Constants
// ============================================================================

/** Model to use for embeddings */
const MODEL_NAME = 'all-MiniLM-L6-v2'

export { EMBEDDING_DIMENSION } from './embeddings-constants'

/** Minimum content length to generate embedding */
const MIN_CONTENT_LENGTH = 10

/** Maximum characters for embedding input (~512 tokens) */
const MAX_CONTENT_LENGTH = 2000
/**
 * The `serviceName` fork option, which is also what Electron reports as
 * `details.name` on `app.on('child-process-gone')` — the only channel that
 * actually observes a native worker crash. Shared so the two cannot drift.
 */
const WORKER_SERVICE_NAME = 'Embeddings'

const REQUEST_TIMEOUT_MS = 5 * 60_000
const START_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const IDLE_SHUTDOWN_MS = 30_000

/**
 * Model-load retry policy (#840).
 *
 * A failed load is almost always the ~23MB download failing (offline, proxy,
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

// ============================================================================
// Helper Functions
// ============================================================================

type PendingRequest = {
  resolve: (value: EmbeddingWorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Progress notes transformers.js writes to the worker's stderr during a model
 * download. They are informational, not failures, but logging the whole stream
 * at error put them in the production error feed (#846).
 */
const INFORMATIONAL_WORKER_STDERR = [
  /Unable to determine content-length from response headers/i
] as const

/**
 * True only when every line in the chunk is a known-benign note, so a real
 * error interleaved with progress output still surfaces at error level.
 */
export function isInformationalWorkerStderr(output: string): boolean {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  return lines.every((line) => INFORMATIONAL_WORKER_STDERR.some((pattern) => pattern.test(line)))
}

/**
 * Emit model loading progress to all renderer windows
 */
function emitProgress(phase: EmbeddingProgressPhase, progress: number, status: string): void {
  broadcastToAllWindows(SettingsChannels.events.EMBEDDING_PROGRESS, {
    phase,
    progress,
    status
  })
}

class EmbeddingModelBridge {
  private process: ReturnType<typeof utilityProcess.fork> | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null
  private requestCounter = 0
  private loaded = false
  private loading = false
  // Circuit breaker: latched when model loads keep failing (download stall, worker
  // crash, timeout). While set, loadModel() and embed() short-circuit instead of
  // re-forking the worker and re-attempting the ~23MB download per note — the loop
  // that made vault-open hang indefinitely (#803). Cleared on a successful load, on
  // reset(), and when AI is re-enabled (resetEmbeddingModelFailure).
  private loadFailed = false
  // Consecutive failures feeding the retry backoff. Latching on the FIRST failure
  // (as this breaker originally did) meant a 5-second network blip silently killed
  // semantic indexing for the rest of the app session, so instead the failures are
  // counted and spaced out, and only the Nth latches for good (#840).
  private consecutiveFailures = 0
  // Epoch ms before which no load may be attempted. 0 = retry allowed now.
  private retryNotBefore = 0
  private error: string | null = null
  private shuttingDown = false
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null
  // Latched when WE force-kill the worker (shutdown timeout / reset). The kill's
  // 'exit' arrives as a later macrotask, after `shuttingDown` is already cleared,
  // so the exit handler cannot recover the phase from `shuttingDown` alone —
  // without this latch a wedged teardown is misreported as `idle` ("died doing
  // nothing") instead of `idle_shutdown` ("died tearing down").
  private pendingExitPhase: WorkerExitPhase | null = null

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
      loading: this.loading,
      error: this.error
    }
  }

  async loadModel(): Promise<boolean> {
    // A recent load already failed — do not re-fork the worker or re-attempt the
    // download until the backoff expires. Once the breaker latches for good,
    // recover via resetEmbeddingModelFailure() (AI re-enable), unloadModel(), or
    // app restart.
    if (this.isBreakerOpen()) {
      return false
    }

    try {
      this.loading = !this.loaded
      await this.start()
      const requestId = this.nextRequestId()
      const response = await this.sendRequest({
        type: 'load-model',
        requestId
      })

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
      this.recordSuccess()
      return true
    } catch (error) {
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

    try {
      this.loading = !this.loaded
      await this.start()
      const requestId = this.nextRequestId()
      const response = await this.sendRequest({
        type: 'embed',
        requestId,
        text: text.substring(0, MAX_CONTENT_LENGTH)
      })

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
      this.recordSuccess()
      return embedding
    } catch (error) {
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      if (!wasLoaded) {
        this.recordFailure()
      }
      logger.error('Generation failed:', error)
      // Until now this failure only ever reached electron-log, so a user
      // silently losing semantic-search indexing was invisible to us. Throttled
      // because a broken worker fails once per note edit; we need the yes/no,
      // not the volume (worker_exit_* above carries the true cadence).
      if (shouldEmitThrottled('embeddings:embed_failed')) {
        trackMainLog('error', {
          scope: 'Embeddings',
          action: 'embed_failed',
          errorCode: error instanceof Error && error.name ? error.name : 'UnknownError'
        })
      }
      return null
    }
  }

  async stop(): Promise<void> {
    this.clearIdleShutdown()

    if (!this.process) {
      this.readyPromise = null
      this.loaded = false
      this.loading = false
      return
    }

    const activeProcess = this.process
    this.shuttingDown = true
    this.loaded = false
    this.loading = false

    activeProcess.postMessage({ type: 'shutdown' } satisfies EmbeddingMainToWorkerMessage)

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // The worker ignored the graceful shutdown and wedged — this is the
        // onnxruntime-dispose failure mode this telemetry exists to catch. Latch
        // the phase before killing: the kill's 'exit' races (and loses to) the
        // `shuttingDown = false` reset below.
        this.pendingExitPhase = 'idle_shutdown'
        activeProcess.kill()
        resolve()
      }, SHUTDOWN_TIMEOUT_MS)

      activeProcess.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.process = null
    this.readyPromise = null
    this.shuttingDown = false
  }

  reset(): void {
    this.shuttingDown = true
    this.clearIdleShutdown()
    // Same force-kill race as stop(): latch the phase so the kill's async 'exit'
    // is attributed to a deliberate teardown, not a spontaneous `idle` death.
    // Cleared — not left alone — when there is nothing to kill: the latch now
    // outlives the exit handler (which never runs for a native crash), so a stale
    // one would make the NEXT worker's crash read as a teardown it never had.
    this.pendingExitPhase = this.process ? 'idle_shutdown' : null
    this.process?.kill()
    this.process = null
    this.readyPromise = null
    this.rejectAll(new Error('Embedding utility reset'))
    this.loaded = false
    this.loading = false
    this.clearLoadFailure()
    this.error = null
    this.shuttingDown = false
  }

  clearLoadFailure(): void {
    this.loadFailed = false
    this.consecutiveFailures = 0
    this.retryNotBefore = 0
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

  private async start(): Promise<void> {
    this.clearIdleShutdown()

    if (this.process) {
      await this.readyPromise
      return
    }

    const workerPath = path.join(__dirname, 'embedding-worker.js')
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: WORKER_SERVICE_NAME,
      stdio: 'pipe',
      env: {
        ...process.env,
        MEMRY_USER_DATA_PATH: app.getPath('userData')
      },
      allowLoadingUnsignedLibraries: process.platform === 'darwin'
    })

    this.process = child
    // A fresh worker must never inherit a force-kill phase latched for a prior one.
    this.pendingExitPhase = null
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) {
        logger.info(`Embedding utility stdout: ${output}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (!output) return
      if (isInformationalWorkerStderr(output)) {
        logger.debug(`Embedding utility stderr: ${output}`)
        return
      }
      logger.error(`Embedding utility stderr: ${output}`)
    })

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error('Embedding utility failed to start within timeout')
        logger.error('Embedding utility start timeout', {
          workerPath,
          pid: child.pid
        })
        this.failProcess(error)
        reject(error)
      }, START_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timeout)
        child.off('message', onMessage)
        child.off('error', onFatalError)
        child.off('exit', onExitBeforeReady)
      }

      const onMessage = (message: EmbeddingWorkerToMainMessage): void => {
        if (message.type === 'log') {
          getLogShip()?.ingestForwarded(message.record, 'Embeddings')
          return
        }

        if (message.type !== 'ready') return

        cleanup()
        this.setupProcessHandlers(child)
        logger.info('Embedding utility ready')
        resolve()
      }

      const onFatalError = (type: string, location: string, report: string): void => {
        cleanup()
        const error = new Error(`Embedding utility fatal error: ${type} at ${location}`)
        logger.error('Embedding utility fatal error', { type, location, report })
        this.failProcess(error)
        reject(error)
      }

      const onExitBeforeReady = (code: number): void => {
        cleanup()
        const forcedPhase = this.pendingExitPhase
        this.pendingExitPhase = null
        // A clean exit during shutdown is lifecycle, not a fault (mirrors the
        // ready-state guard below). Without this, quitting the app mid-bootstrap
        // emits a spurious error-level worker_exit_starting with exit code 0.
        if (!(forcedPhase === null && this.shuttingDown && code === 0)) {
          this.trackWorkerExit(forcedPhase ?? 'starting', code)
        }
        const error = new Error(`Embedding utility exited unexpectedly (code ${code})`)
        this.failProcess(error)
        reject(error)
      }

      child.on('message', onMessage)
      child.on('error', onFatalError)
      child.on('exit', onExitBeforeReady)
    })

    await this.readyPromise
  }

  private setupProcessHandlers(child: ReturnType<typeof utilityProcess.fork>): void {
    child.on('message', (message: EmbeddingWorkerToMainMessage) => {
      if (message.type === 'log') {
        getLogShip()?.ingestForwarded(message.record, 'Embeddings')
        return
      }

      if (message.type === 'ready') {
        return
      }

      if (message.type === 'progress') {
        this.applyProgress(message)
        return
      }

      if ('requestId' in message) {
        const pending = this.pendingRequests.get(message.requestId)
        if (!pending) {
          return
        }

        clearTimeout(pending.timer)
        this.pendingRequests.delete(message.requestId)

        if (message.type === 'error') {
          this.error = message.error
          this.loading = false
          this.scheduleIdleShutdown()
          pending.resolve(message)
          return
        }

        this.scheduleIdleShutdown()
        pending.resolve(message)
      }
    })

    child.on('error', (type: string, location: string, report: string) => {
      const error = new Error(`Embedding utility fatal error: ${type} at ${location}`)
      logger.error('Embedding utility fatal error', { type, location, report })
      this.failProcess(error)
    })

    child.on('exit', (code: number) => {
      const forcedPhase = this.pendingExitPhase
      this.pendingExitPhase = null

      // A clean, graceful shutdown (the worker exited 0 on its own after the
      // shutdown message) is lifecycle, not a fault. A forced kill (forcedPhase
      // set) is a teardown death worth measuring even though shuttingDown may
      // already be cleared by the time its async 'exit' lands.
      if (forcedPhase === null && this.shuttingDown && code === 0) {
        this.process = null
        this.readyPromise = null
        return
      }

      // Phase must be read before failProcess(), which rejects and clears the
      // pending requests this classification depends on.
      this.trackWorkerExit(forcedPhase ?? this.currentPhase(), code)
      const error = new Error(`Embedding utility exited unexpectedly (code ${code})`)
      this.failProcess(error)
    })
  }

  private currentPhase(): WorkerExitPhase {
    if (this.shuttingDown) return 'idle_shutdown'
    if (this.pendingRequests.size > 0) return 'in_flight'
    return 'idle'
  }

  /**
   * The phase to attribute a death to when it is reported by
   * `app.on('child-process-gone')` rather than by the worker's own 'exit' event.
   *
   * Production says that is the only report we get: across 107 consecutive
   * `Utility:crashed:Embeddings` events, `trackWorkerExit` below emitted nothing
   * and neither did `embed_failed` — a native SIGABRT out of the model runtime is
   * neither a graceful exit nor a V8 fatal error, so no instance event fires and
   * this bridge never learns its worker died. Reading the phase from outside the
   * handler is what makes that surviving report answer the only question that
   * matters: did the user lose an embedding, or did the worker just die tearing
   * down after already delivering one?
   */
  liveWorkerPhase(): WorkerExitPhase | null {
    if (this.pendingExitPhase) return this.pendingExitPhase
    return this.process ? this.currentPhase() : null
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

  private sendRequest(
    message: Extract<EmbeddingMainToWorkerMessage, { requestId: string }>
  ): Promise<EmbeddingWorkerToMainMessage> {
    if (!this.process) {
      return Promise.reject(new Error('Embedding utility is not running'))
    }

    this.clearIdleShutdown()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(message.requestId)
        this.scheduleIdleShutdown()
        reject(new Error(`Embedding request timed out: ${message.type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(message.requestId, { resolve, reject, timer })
      this.process!.postMessage(message)
    })
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `embedding_${this.requestCounter}_${Date.now()}`
  }

  private failProcess(error: Error): void {
    this.clearIdleShutdown()
    if (this.process) {
      this.process = null
    }
    this.readyPromise = null
    this.loaded = false
    this.loading = false
    this.error = error.message
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleShutdown()

    if (!this.process || this.pendingRequests.size > 0 || this.shuttingDown) {
      return
    }

    this.idleShutdownTimer = setTimeout(() => {
      this.idleShutdownTimer = null
      if (!this.process || this.pendingRequests.size > 0 || this.shuttingDown) {
        return
      }

      void this.stop().catch((error) => {
        logger.warn('Embedding utility idle shutdown failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }, IDLE_SHUTDOWN_MS)
  }

  private clearIdleShutdown(): void {
    if (!this.idleShutdownTimer) {
      return
    }

    clearTimeout(this.idleShutdownTimer)
    this.idleShutdownTimer = null
  }
}

const bridge = new EmbeddingModelBridge()

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the embedding model.
 * Downloads the model on first use (~23MB).
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
 * Lifecycle phase to attribute a `child-process-gone` report to.
 *
 * Returns null when the report is not about our embedding worker, or when no
 * worker was live — so an unrelated crash never inherits a phase.
 *
 * @param workerName - `details.name` from `app.on('child-process-gone')`
 */
export function getEmbeddingWorkerPhase(workerName: string | undefined): WorkerExitPhase | null {
  if (workerName !== WORKER_SERVICE_NAME) return null
  return bridge.liveWorkerPhase()
}
