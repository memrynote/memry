/**
 * Does this install sync at all?
 *
 * `startSyncRuntime` refuses to start for three policy reasons — no session, an
 * unconfirmed recovery phrase, and a free plan — and in every one of them the
 * sync services stay null for the whole session by design. A local mutation
 * raised on such an install is not a lost edit: there is no peer to tell and no
 * queue to reach. It is only a lost edit when the runtime *should* be up.
 *
 * That distinction is why this flag exists. Without it, a signed-in free-plan
 * user with Google Calendar connected polled every 5 minutes forever and every
 * polled row emitted the `local_mutation_dropped` tripwire — ~92% of a
 * 30k-event/day self-DoS that buried every other desktop error signal (#1579).
 *
 * Deliberately NOT cleared by `stopSyncRuntime`. Quit, vault switch and re-auth
 * all stop the runtime on an install that still syncs, and those windows are
 * exactly where a delete goes missing — the tombstone recorder has to stay
 * armed through them. Sign-out clears it, because that install stops syncing.
 *
 * In-memory and per-session: it starts `false`, so the window before the first
 * start attempt behaves as it always has.
 */
let syncEligible = false

/**
 * The runtime's policy gates have answered for the open vault. False from a
 * vault's open until `startSyncRuntime` reaches a verdict, so a consumer can
 * tell "this install does not sync" from "the verdict is not in yet" (#1417).
 */
let syncDecided = false

/**
 * Memry sync delivered a pull since the runtime started: this device holds what
 * other devices wrote up to that point (#1408 D8).
 */
let pullCompleted = false

/** Past every policy gate: the runtime is expected to be running. */
export function markSyncEligible(): void {
  syncEligible = true
  syncDecided = true
}

/**
 * This install does not sync. Returns the `null` every caller returns anyway —
 * each one is a branch that declines to start the runtime — so the decision and
 * the flag cannot drift apart.
 */
export function markSyncIneligible(): null {
  syncEligible = false
  syncDecided = true
  return null
}

export function isSyncEligible(): boolean {
  return syncEligible
}

export function isSyncDecided(): boolean {
  return syncDecided
}

/** The runtime stopped, so the next start decides again and pulls again. */
export function resetSyncDecision(): void {
  syncDecided = false
  pullCompleted = false
}

/** A full sync's pull delivered. */
export function markPullCompleted(): void {
  pullCompleted = true
}

export function hasCompletedPullSinceStart(): boolean {
  return pullCompleted
}
