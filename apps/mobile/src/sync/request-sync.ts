import { getReadOnlyState } from './read-only-mode'

/**
 * The one place that decides what a sync trigger actually does.
 *
 * "Drain then pull" used to be written out at each call site and "drain only"
 * at two more, so every new trigger was a fresh chance to forget half of it,
 * and none of them were testable — the drain reaches the http client, which
 * imports `@react-native-community/netinfo` at module scope.
 */

export type SyncReason =
  'app-foreground' | 'app-background' | 'background-task' | 'online' | 'socket'

export interface SyncTriggerDeps {
  drain: (vaultId: string) => Promise<void>
  sync: (vaultId: string) => Promise<unknown>
  /** Defaults to the process-global read-only state. */
  isReadOnly?: () => boolean
}

interface TriggerPlan {
  drain: boolean
  pull: boolean
  /**
   * Whether a parked outbox should skip the drain entirely.
   *
   * Only the high-frequency trigger sets this. `OutboxDrain` parks itself and
   * logs one line per pass, which is right for a handful of app-state edges
   * and wrong for a socket that can deliver a broadcast a second.
   */
  quietWhenParked: boolean
}

/**
 * A table rather than a chain of ifs, because the interesting content here is
 * per-reason data, and the difference between "drains" and "also pulls" is the
 * thing a reader comes to this file to look up.
 */
const PLANS: Record<SyncReason, TriggerPlan> = {
  // Push first, then pull. An edit made offline should leave the device before
  // a pull has the chance to hand the user a stale-looking screen.
  'app-foreground': { drain: true, pull: true, quietWhenParked: false },
  'background-task': { drain: true, pull: true, quietWhenParked: false },
  // Drain only, and immediately: iOS may suspend the process at any point
  // after the transition.
  'app-background': { drain: true, pull: false, quietWhenParked: false },
  // The engine's own NetInfo handler already pulls on this edge. What nothing
  // did was PUSH, so edits made offline sat in the queue with attempt_count
  // still 0 on a device that never left the foreground.
  online: { drain: true, pull: false, quietWhenParked: false },
  socket: { drain: true, pull: true, quietWhenParked: true }
}

/**
 * Run one trigger. Never throws: these are called from AppState listeners and
 * socket handlers, where a rejection is an unhandled rejection and the work it
 * failed to do is still queued for the next pass.
 */
export async function requestSync(
  deps: SyncTriggerDeps,
  vaultId: string,
  reason: SyncReason
): Promise<void> {
  const plan = PLANS[reason]
  if (!plan) return

  const readOnly = (deps.isReadOnly ?? (() => getReadOnlyState().readOnly))()

  if (plan.drain && !(plan.quietWhenParked && readOnly)) {
    await settle(() => deps.drain(vaultId))
  }
  if (plan.pull) {
    await settle(() => deps.sync(vaultId))
  }
}

/**
 * `.catch()` alone is not enough. `getSyncEngine(id).sync()` can throw
 * SYNCHRONOUSLY out of the engine constructor, which subscribes to NetInfo,
 * and every caller here uses `void requestSync(...)` -- so that throw becomes
 * exactly the unhandled rejection this function promises not to produce.
 */
async function settle(task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch {
    // Logged by the drain and the engine themselves; the work is still queued.
  }
}
