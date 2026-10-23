import type { ReadwiseRunError, ReadwiseRunProgress } from '@memry/contracts/import-channels'
import { ReadwiseError } from './client'
import { ReadwisePullGateError } from './pull-gate'

/**
 * Live Readwise run state for the status IPC (#1418): the run in progress, and
 * the last failure. Both are in memory. A failure the user must fix also parks
 * the schedule through `LastRun`, which persists (`sync-state.ts`).
 */

const PROGRESS_NOTIFY_MS = 300

let progress: ReadwiseRunProgress | null = null
let failure: ReadwiseRunError | null = null
let lastNotifyAt = 0
const listeners = new Set<() => void>()

/** Tells the windows to re-read the status. Returns the unsubscribe. */
export function onReadwiseStatusChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  lastNotifyAt = Date.now()
  for (const listener of listeners) listener()
}

export function getRunProgress(): ReadwiseRunProgress | null {
  return progress
}

/** A stage change notifies at once. A per-book tick is throttled, so a big run does not flood IPC. */
export function setRunProgress(next: ReadwiseRunProgress | null, options: { tick?: boolean } = {}) {
  progress = next
  if (options.tick && Date.now() - lastNotifyAt < PROGRESS_NOTIFY_MS) return
  notify()
}

export function getRunFailure(): ReadwiseRunError | null {
  return failure
}

export function clearRunFailure(): void {
  if (failure === null) return
  failure = null
  notify()
}

/**
 * The failure a run ended with, as the status shows it. A pull-gate refusal
 * (another device pulls, sync not ready) is a state of its own, not a failure.
 */
export function classifyRunFailure(error: unknown): ReadwiseRunError | null {
  if (error instanceof ReadwisePullGateError) return null
  if (error instanceof ReadwiseError) return { kind: error.code, detail: null }
  return { kind: 'unexpected', detail: error instanceof Error ? error.message : String(error) }
}

export function recordRunFailure(error: unknown): void {
  const next = classifyRunFailure(error)
  if (next === null) return
  failure = next
  notify()
}
