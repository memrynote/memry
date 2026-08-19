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
 *             unbounded steps (close snapshots, local servers, telemetry flush,
 *             final sync push, vault close).
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
  options: { budgetMs?: number } = {}
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
