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
import fs from 'fs'
import path from 'path'
import { SettingsChannels } from '@memry/contracts/ipc-channels'
import { redactText } from '@memry/contracts/redact'
import type {
  EmbeddingEncoderModality,
  EmbeddingMainToWorkerMessage,
  EmbeddingProgressMessage,
  EmbeddingProgressPhase,
  EmbeddingWorkerToMainMessage,
  ImageEmbedder,
  ImageEmbedOptions
} from './embedding-model-protocol'
import {
  EMBEDDING_DIMENSION,
  embeddingModelCacheDir,
  embeddingModelWeightsPath,
  embeddingAudioWeightsPath,
  embeddingVisionWeightsPath
} from './embeddings-constants'
import { MAX_EMBEDDING_INPUT_LENGTH } from './embedding-input'
import { createLogger } from './logger'
import { lowerProcessPriority } from './low-priority'
import { broadcastToAllWindows } from './window-broadcast'
import { isChildProcessFault, trackMainLog } from '../telemetry/diagnostics'
import { getLogShip } from '../telemetry/log-ship'
import { getMainRedactOptions } from '../telemetry/redact-options'
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
  'live' | 'teardown' | 'start_timeout' | 'fatal_error' | 'exit' | 'graceful_stop'

/** Whether the model was already on disk when this worker was forked. */
export type ModelCacheState = 'present' | 'partial' | 'absent' | 'unknown'

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
  loaded: boolean
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

/**
 * Bytes of worker stderr kept for the crash report. A native abort out of
 * onnxruntime/libc writes its message to fd 2 and then dies, so the TAIL is the
 * part worth keeping. Hard-capped: this is unbounded native output and it has to
 * fit inside TelemetryErrorDetailSchema.stack (4000).
 */
const STDERR_TAIL_LIMIT = 2000

// ============================================================================
// Helper Functions
// ============================================================================

type PendingRequest = {
  resolve: (value: EmbeddingWorkerToMainMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Facts about one forked worker, captured at fork time. */
type WorkerGeneration = {
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
 * Whether the model was already on disk when a worker was forked, and how
 * big it was. A torn/partially-written cache file aborts deterministically on
 * every load, which is the shape a per-install repeat crash would have; nothing
 * in the crash payload could distinguish it before.
 *
 * Never throws and never awaits: it runs on the fork path, so a stat failure has
 * to degrade to `unknown` rather than take the worker down with it.
 */
export function probeModelCache(userDataPath: string): {
  state: ModelCacheState
  bytes?: number
} {
  try {
    const stat = fs.statSync(embeddingModelWeightsPath(userDataPath), { throwIfNoEntry: false })
    if (stat?.isFile()) return { state: 'present', bytes: stat.size }
    // Weights missing but the model dir exists: an interrupted or partially
    // written download, which is a different bug from "never downloaded".
    const dir = fs.statSync(embeddingModelCacheDir(userDataPath), { throwIfNoEntry: false })
    return { state: dir?.isDirectory() ? 'partial' : 'absent' }
  } catch {
    return { state: 'unknown' }
  }
}

/**
 * Whether an on-demand encoder is on disk. The cache writes each file to
 * a temp name and renames it, so a killed download never leaves a torn weights
 * file: it is either `present` or `absent`.
 */
export function probeEncoderCache(
  userDataPath: string,
  modality: EmbeddingEncoderModality
): ModelCacheState {
  const weights =
    modality === 'vision'
      ? embeddingVisionWeightsPath(userDataPath)
      : embeddingAudioWeightsPath(userDataPath)
  try {
    return fs.statSync(weights, { throwIfNoEntry: false })?.isFile() ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}

/**
 * Prepare captured worker stderr for the crash event: redact it, cap it, and
 * make sure no line can be mistaken for a JS stack frame.
 *
 * The frame guard matters. The tail ships in `error.stack`, and the sync-server
 * parses that field back into PostHog Error Tracking frames by matching
 * `/^\s*at\s/` per line (posthog-transform.ts). A native abort message that
 * happened to start with "at " would become a fabricated frame pointing at
 * nothing, so every line is prefixed out of that shape.
 */
export function formatWorkerStderrTail(tail: string): string | undefined {
  const redacted = redactText(tail, getMainRedactOptions()).trim()
  if (!redacted) return undefined
  const lines = redacted
    .split('\n')
    .map((line) => `| ${line.trim()}`)
    .filter((line) => line !== '| ')
  if (lines.length === 0) return undefined
  return `worker stderr tail:\n${lines.join('\n')}`.slice(0, STDERR_TAIL_LIMIT)
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
  cancelled: boolean
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
    vision: { failures: 0, retryNotBefore: 0, cancelled: false },
    audio: { failures: 0, retryNotBefore: 0, cancelled: false }
  }
  private error: string | null = null
  private shuttingDown = false
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null
  // Latched when WE force-kill the worker (shutdown timeout / reset). The kill's
  // 'exit' arrives as a later macrotask, after `shuttingDown` is already cleared,
  // so the exit handler cannot recover the phase from `shuttingDown` alone —
  // without this latch a wedged teardown is misreported as `idle` ("died doing
  // nothing") instead of `idle_shutdown` ("died tearing down").
  private pendingExitPhase: WorkerExitPhase | null = null
  // Per-generation facts about the CURRENT worker, all captured at fork time so a
  // crash report can be read without guessing. Reset on every fork.
  private worker: WorkerGeneration | null = null
  // The worker the bridge most recently let go of. Production's crash reports all
  // arrive in this state — `process` and `pendingExitPhase` both already null —
  // so without this record every report resolves to no phase at all. TTL'd, so a
  // late unrelated crash cannot inherit it.
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
      if (this.embedFailures === 0) this.recordSuccess()
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
        text: text.substring(0, MAX_EMBEDDING_INPUT_LENGTH)
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
      this.embedFailures = 0
      this.recordSuccess()
      return embedding
    } catch (error) {
      this.loading = false
      this.error = error instanceof Error ? error.message : String(error)
      this.embedFailures += 1
      this.recordFailure()
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
    message: (requestId: string) => Extract<EmbeddingMainToWorkerMessage, { requestId: string }>
  ): Promise<Float32Array | null> {
    const breaker = this.encoderBreakers[modality]
    if (this.isBreakerOpen() || Date.now() < breaker.retryNotBefore) return null

    breaker.cancelled = false
    try {
      await this.start()
      if (this.worker && this.worker[modality] === 'off') this.worker[modality] = 'loading'
      const response = await this.sendRequest(message(this.nextRequestId()))

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

      if (this.worker) this.worker[modality] = 'ready'
      breaker.failures = 0
      breaker.retryNotBefore = 0
      return embedding
    } catch (error) {
      // cancelEncoderLoad() kills the worker on purpose; that is not a failure.
      if (!breaker.cancelled) {
        this.recordEncoderFailure(modality, error instanceof Error ? error.message : String(error))
      }
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
    this.encoderBreakers[modality].cancelled = true
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

    // Whether it exited on its own or had to be force-killed, the bridge is done
    // with this worker here. Record it so a crash report landing after the handle
    // is gone is still attributed — a no-op when an exit handler already did.
    this.releaseWorker('teardown', 'idle_shutdown')
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
    // Same rule as the latch above, for the same reason: a live worker is
    // recorded so a crash report can still find it, while a reset with nothing
    // to kill wipes the record — a stale one would make an unrelated later crash
    // read as a teardown it never had.
    if (this.process) this.releaseWorker('teardown', 'idle_shutdown')
    else this.lastWorker = null
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

  private async start(): Promise<void> {
    this.clearIdleShutdown()

    if (this.process) {
      await this.readyPromise
      return
    }

    const workerPath = path.join(__dirname, 'embedding-worker.js')
    const userDataPath = app.getPath('userData')
    const modelCache = probeModelCache(userDataPath)
    const visionCache = probeEncoderCache(userDataPath, 'vision')
    const audioCache = probeEncoderCache(userDataPath, 'audio')
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: WORKER_SERVICE_NAME,
      stdio: 'pipe',
      env: {
        ...process.env,
        MEMRY_USER_DATA_PATH: userDataPath
      },
      allowLoadingUnsignedLibraries: process.platform === 'darwin'
    })

    // Inference is background work: a vault-wide re-embed must not take the
    // machine's CPU away from the user. The pid exists once the process spawns.
    child.once('spawn', () => lowerProcessPriority(child.pid))
    this.process = child
    // A fresh worker must never inherit a force-kill phase latched for a prior one.
    this.pendingExitPhase = null
    const generation: WorkerGeneration = {
      pid: child.pid,
      forkedAt: Date.now(),
      ready: false,
      modelCache: modelCache.state,
      modelCacheBytes: modelCache.bytes,
      vision: 'off',
      visionCache,
      audio: 'off',
      audioCache,
      // Read BEFORE this attempt can fail, so it describes the state the fork was
      // made in: `reload` means a load had already failed before this worker.
      load: this.consecutiveFailures > 0 ? 'reload' : 'first',
      stderrTail: '',
      releasePhase: null
    }
    this.worker = generation
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (output) {
        logger.info(`Embedding utility stdout: ${output}`)
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const output = chunk.toString().trim()
      if (!output) return
      // Kept for THIS generation even when the line is benign: a native abort is
      // usually preceded by the runtime's own progress notes, and the tail is the
      // only "what happened" a crash report can ever carry. Bounded from the end.
      generation.stderrTail = `${generation.stderrTail}${output}\n`.slice(-STDERR_TAIL_LIMIT)
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
        this.failProcess(error, 'start_timeout')
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
        generation.ready = true
        this.setupProcessHandlers(child)
        logger.info('Embedding utility ready')
        resolve()
      }

      const onFatalError = (type: string, location: string, report: string): void => {
        cleanup()
        const error = new Error(`Embedding utility fatal error: ${type} at ${location}`)
        logger.error('Embedding utility fatal error', { type, location, report })
        this.failProcess(error, 'fatal_error')
        reject(error)
      }

      const onExitBeforeReady = (code: number): void => {
        cleanup()
        const forcedPhase = this.pendingExitPhase
        this.pendingExitPhase = null
        // A clean exit during shutdown is lifecycle, not a fault (mirrors the
        // ready-state guard below). Without this, quitting the app mid-bootstrap
        // emits a spurious error-level worker_exit_starting with exit code 0.
        const phase = forcedPhase ?? 'starting'
        if (!(forcedPhase === null && this.shuttingDown && code === 0)) {
          this.trackWorkerExit(phase, code)
        }
        const error = new Error(`Embedding utility exited unexpectedly (code ${code})`)
        this.failProcess(error, 'exit', phase)
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
      this.failProcess(error, 'fatal_error')
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
        // Still recorded: a runtime that aborts while unwinding after exit(0)
        // produces a crash report AFTER this clean exit, and the teardown-abort
        // hypothesis is only testable if that report can still find the worker.
        this.releaseWorker('graceful_stop')
        this.readyPromise = null
        return
      }

      // Phase must be read before failProcess(), which rejects and clears the
      // pending requests this classification depends on.
      const phase = forcedPhase ?? this.currentPhase()
      this.trackWorkerExit(phase, code)
      const error = new Error(`Embedding utility exited unexpectedly (code ${code})`)
      this.failProcess(error, 'exit', phase)
    })
  }

  private currentPhase(): WorkerExitPhase {
    if (this.shuttingDown) return 'idle_shutdown'
    if (this.pendingRequests.size > 0) return 'in_flight'
    // A worker that never sent 'ready' died bootstrapping, not sitting idle.
    if (this.worker && !this.worker.ready) return 'starting'
    return 'idle'
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

  /**
   * Stop tracking the worker after a fault.
   *
   * This is the path every production crash report arrives behind. It nulls
   * `process` without latching `pendingExitPhase`, so before the last-worker
   * record existed the phase resolver had nothing left to read — which is why
   * 100% of `Utility:crashed:Embeddings` events shipped with no phase.
   *
   * It also used to abandon a still-LIVE child (`start_timeout` / `fatal_error`
   * reach here with the process running): the orphan was unreachable — every
   * request goes through `this.process` — yet kept a whole onnxruntime alive to
   * abort later, and its late `ready` message would re-attach handlers and flip
   * `loaded` on for a worker the bridge no longer owned. It is killed now.
   */
  private failProcess(error: Error, release: WorkerRelease, phase?: WorkerExitPhase): void {
    this.clearIdleShutdown()
    const orphan = this.process
    // Read before rejectAll(), which clears the pending requests the phase
    // classification depends on.
    this.releaseWorker(release, phase)
    if (orphan) {
      this.process = null
      orphan.kill()
    }
    this.readyPromise = null
    this.loaded = false
    this.loading = false
    this.error = error.message
    this.rejectAll(error)
  }

  /**
   * Remember the worker the bridge is letting go of, so a `child-process-gone`
   * report that lands afterwards can still be attributed to it.
   */
  private releaseWorker(release: WorkerRelease, phase?: WorkerExitPhase): void {
    const generation = this.worker
    if (!generation) return
    generation.releasePhase = phase ?? this.currentPhase()
    this.lastWorker = { ...generation, release, releasedAt: Date.now() }
    this.worker = null
  }

  /**
   * The worker a `child-process-gone` report belongs to, with everything the
   * main process knows about it.
   *
   * Reads, in order: the live worker, a force-kill latch (`stop()`/`reset()`
   * kill and null the handle in the same tick), then the last worker the bridge
   * released — the state every production report has actually arrived in.
   */
  crashContext(): EmbeddingWorkerCrashContext | null {
    const now = Date.now()
    if (this.worker) {
      const live = this.worker
      return {
        phase: this.pendingExitPhase ?? this.currentPhase(),
        release: this.pendingExitPhase ? 'teardown' : 'live',
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
 * It also never arrives while the bridge still owns the worker. Every path that
 * nulls `process` either latches a teardown phase (`stop()`/`reset()`) or runs
 * inside an 'exit' handler that emits `EmbeddingWorkerExit` — and production has
 * neither a phase-suffixed event nor an `EmbeddingWorkerExit` on the affected
 * release. What is left is `failProcess()`, which forgets a worker that is still
 * running (start timeout / fatal error) and leaves nothing behind to read. So
 * the answer has to survive the bridge moving on: hence the last-worker record,
 * bounded by LAST_WORKER_TTL_MS so an unrelated later crash cannot inherit it.
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
