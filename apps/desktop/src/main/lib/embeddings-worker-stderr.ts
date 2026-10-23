import fs from 'fs'
import { redactText } from '@memry/contracts/redact'
import type { EmbeddingEncoderModality } from './embedding-model-protocol'
import {
  embeddingModelCacheDir,
  embeddingModelWeightsPath,
  embeddingAudioWeightsPath,
  embeddingVisionWeightsPath
} from './embeddings-constants'
import { getMainRedactOptions } from '../telemetry/redact-options'

/** Whether the model was already on disk when this worker was forked. */
export type ModelCacheState = 'present' | 'partial' | 'absent' | 'unknown'

/**
 * Bytes of worker stderr kept for the crash report. A native abort out of
 * onnxruntime/libc writes its message to fd 2 and then dies, so the TAIL is the
 * part worth keeping. Hard-capped: this is unbounded native output and it has to
 * fit inside TelemetryErrorDetailSchema.stack (4000).
 */
export const STDERR_TAIL_LIMIT = 2000

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
