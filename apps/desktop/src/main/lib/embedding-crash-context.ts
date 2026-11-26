import type { ModelCacheState } from './embeddings-worker-stderr'

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
