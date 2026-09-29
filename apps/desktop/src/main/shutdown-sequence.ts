// Graceful-shutdown orchestration for `before-quit` (#1586).
//
// The chain used to race a flat 5,000 ms timer while its own bounded waits
// summed to 11,000 ms — 2,000 ms for the renderer flush handshake plus 3,000 ms
// for each of the three utility-process stops, run one after another. A quit
// with those utility processes alive therefore could not finish inside its own
// budget, and the forced `app.exit(1)` landed with the CRDT write-back timers
// still armed, dropping up to 5s of the user's most recent edits.
//
// Two rules fix that, and this module exists to make both of them structural:
//
//   * ONE SHARED DEADLINE. The sequence races the whole chain against a single
//     budget, and hands every step a `cap()` that clamps its own bounded wait to
//     what is left. No set of waits can collectively overrun the budget, however
//     many of them there are.
//   * ORDER BY DURABILITY. Steps run strictly in order, so the caller putting
//     the write-back flush at the front is what guarantees it the budget. A
//     wedged teardown step behind it degrades a quit to "slow", not to "lost
//     edits".
//
// It also answers "which step overran": the step in flight when the budget
// expires is reported, so the next occurrence is diagnosable instead of landing
// as an undifferentiated SHUTDOWN_TIMEOUT.

import { createLogger } from './lib/logger'

const log = createLogger('ShutdownSequence')

/**
 * Budget for the whole graceful chain.
 *
 * Derived from the bounded waits it contains rather than guessed:
 *   2,000 ms  renderer flush handshake (windows are flushed in parallel)
 * + 3,000 ms  voice + image + embeddings utility stops (now run concurrently,
 *             so 3,000 ms together instead of 9,000 ms in a row)
 * = 5,000 ms  of bounded waiting, leaving 3,000 ms of headroom for the
 *             remaining steps (close snapshots, local servers, sync stop, vault
 *             close). The final snapshot push and the telemetry flush draw on
 *             that headroom only through their own clamps below, so neither can
 *             starve the vault close (#2522).
 *
 * A quit where nothing is wedged still finishes in milliseconds; this ceiling is
 * only ever reached when a teardown step is genuinely stuck.
 */
export const SHUTDOWN_BUDGET_MS = 8_000

/**
 * Time granted AFTER the budget is gone, purely to make data durable — flushing
 * pending CRDT write-backs and checkpointing SQLite. Bounded, because the whole
 * point of a budget is that quitting must always end.
 */
export const SHUTDOWN_LAST_CHANCE_MS = 1_500

/**
 * Hard ceiling on a quit. The paths above are each bounded, but a quit that
 * never ends is a visibly broken quit, so one timer outside the sequence
 * guarantees the process exits. Sits 500 ms past the latest moment the timeout
 * path can exit on its own (8,000 + 1,500).
 */
export const SHUTDOWN_HARD_BACKSTOP_MS = 10_000

/**
 * Ceiling on the final CRDT snapshot push in `stop-sync-runtime`. Unbounded, it
 * retried each note with 2s/4s/8s backoff one note at a time and routinely
 * outlived the whole budget (#2522). Skipping it is the same outcome as an
 * offline quit or an update install, which already skip it.
 */
export const SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS = 2_000

/**
 * Budget the final snapshot push must leave for the steps behind it
 * (provider flush, vault close: watcher, projection drain, activity log,
 * SQLite checkpoint). Without it a slow push ran `close-vault` out of time.
 */
export const SHUTDOWN_CLOSE_VAULT_RESERVE_MS = 2_000

/**
 * Ceiling on the telemetry + log-ship flush. Both queues are mirrored to disk
 * on every enqueue and drain on the next launch, so an unsent batch is delayed,
 * not lost; a network flush must never hold a quit open.
 */
export const SHUTDOWN_TELEMETRY_FLUSH_MS = 1_000

/**
 * The final snapshot push's timeout: `SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS`, clamped
 * so `SHUTDOWN_CLOSE_VAULT_RESERVE_MS` of the shared budget is still left after
 * it. Zero when the budget is already that thin: the push is skipped outright.
 */
export function finalSnapshotPushTimeoutMs(deadline: ShutdownDeadline): number {
  return Math.max(
    0,
    Math.min(
      SHUTDOWN_FINAL_SNAPSHOT_PUSH_MS,
      deadline.remainingMs() - SHUTDOWN_CLOSE_VAULT_RESERVE_MS
    )
  )
}

export interface ShutdownDeadline {
  /** Milliseconds left in the shared budget. Never negative. */
  remainingMs: () => number
  /**
   * `preferredMs`, clamped to what is left of the shared budget. A bounded wait
   * must never be allowed to outlive the deadline it is running under.
   */
  cap: (preferredMs: number) => number
}

export interface ShutdownStep {
  /**
   * Stable kebab-case id. It reaches the crash marker and, on the next launch,
   * the `app_crashed` errorCode — so it must stay a bounded, enumerable token.
   */
  name: string
  run: (deadline: ShutdownDeadline) => void | Promise<void>
}

export interface ShutdownOutcome {
  status: 'complete' | 'timeout'
  /** The step still in flight when the budget ran out. */
  overrunStep: string | null
  /** How long that step alone had been running. */
  overrunStepMs: number
  elapsedMs: number
}

/**
 * Run `steps` in order under one shared budget.
 *
 * Resolves `complete` when every step finished, or `timeout` at exactly
 * `budgetMs` naming the step that was still running. Rejects only when a step
 * itself rejected — that stays the caller's "cleanup failed" path, which is a
 * different signal from "cleanup did not finish in time".
 */
export async function runShutdownSequence(
  steps: readonly ShutdownStep[],
  options: {
    budgetMs?: number
    /**
     * Called synchronously as each step starts. The quit path persists the name
     * here, so a process that dies mid-step (and never sees the outcome) still
     * leaves the step behind for the next launch to report.
     */
    onStepStart?: (name: string) => void
  } = {}
): Promise<ShutdownOutcome> {
  const budgetMs = options.budgetMs ?? SHUTDOWN_BUDGET_MS
  const startedAt = Date.now()
  const deadlineAt = startedAt + budgetMs

  const deadline: ShutdownDeadline = {
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    cap: (preferredMs) => Math.max(0, Math.min(preferredMs, deadlineAt - Date.now()))
  }

  let inFlight: { name: string; startedAt: number } | null = null
  // Read through a call: the assignments below happen inside a closure, so a
  // direct read narrows to `null` and the step name is lost at compile time.
  const currentStep = (): { name: string; startedAt: number } | null => inFlight

  const chain = (async () => {
    for (const step of steps) {
      const stepStartedAt = Date.now()
      inFlight = { name: step.name, startedAt: stepStartedAt }
      options.onStepStart?.(step.name)
      await step.run(deadline)
      log.info('step complete', { step: step.name, elapsedMs: Date.now() - stepStartedAt })
      inFlight = null
    }
  })()

  // The chain must never reject the race directly: once the budget has won,
  // nothing is left to handle a late rejection and it would surface as an
  // unhandled rejection while the process is already on its way out.
  const settled = chain.then(
    () => ({ kind: 'complete' as const }),
    (error: unknown) => ({ kind: 'error' as const, error })
  )

  let expiry: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>((resolve) => {
    expiry = setTimeout(() => resolve('timeout'), budgetMs)
  })

  const winner = await Promise.race([settled, expired])
  clearTimeout(expiry)

  if (winner === 'timeout') {
    const step = currentStep()
    const outcome: ShutdownOutcome = {
      status: 'timeout',
      overrunStep: step?.name ?? null,
      overrunStepMs: step ? Date.now() - step.startedAt : 0,
      elapsedMs: Date.now() - startedAt
    }
    log.error('shutdown budget exhausted', outcome)
    return outcome
  }

  if (winner.kind === 'error') throw winner.error

  return {
    status: 'complete',
    overrunStep: null,
    overrunStepMs: 0,
    elapsedMs: Date.now() - startedAt
  }
}

/**
 * Await `work`, but give up after `ms`. Returns whether it finished in time.
 * `work` keeps running — the caller is about to exit the process anyway; this
 * only bounds how long the exit waits for it.
 */
export async function completeWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let expiry: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<false>((resolve) => {
    expiry = setTimeout(() => resolve(false), ms)
  })
  const finished = await Promise.race([work.then(() => true), expired])
  clearTimeout(expiry)
  return finished
}
