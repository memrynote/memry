import { createLogger } from '../logging'

const log = createLogger('CrdtPendingNotes')

/**
 * Durable record of notes whose CRDT updates never reached the server.
 *
 * The engine-side drain below is platform-free; what differs per shell is only
 * where the note ids survive a process death. Desktop implements this over an
 * fsync'd JSON file in userData (`crdt-pending-notes.ts`); mobile implements it
 * over a SQLite table. All three calls are synchronous on purpose: one caller
 * is the update queue's `stop()`, which runs while the process is quitting and
 * cannot await anything — the id must be durable before the call returns.
 */
export interface PendingNoteStore {
  read(): string[]
  record(noteIds: string[]): void
  clear(noteIds: string[]): void
}

export interface PendingCrdtDrainDeps {
  /**
   * Pull this note's server state and merge it into the local doc. `false`
   * means the merge did not complete, and the snapshot must NOT be pushed —
   * see the ordering note on `drainPendingNotes`.
   */
  mergeRemote: (noteId: string) => Promise<boolean>
  /** Push the note's full CRDT state to the server. `false` means try again. */
  pushSnapshot: (noteId: string) => Promise<boolean>
  /** `false` for notes that no longer exist or never sync via CRDT (binaries). */
  isSyncable: (noteId: string) => boolean
  /**
   * Tripped when the runtime that supplied these deps is torn down.
   *
   * `mergeRemote` and `pushSnapshot` both close over one `SyncEngine` and one
   * `CrdtProvider`, and neither survives `stopSyncRuntime`. Nothing awaits this
   * drain — `replayPendingCrdtNotes` is fire-and-forget — so without a liveness
   * signal a run started by a dying session keeps merging server state into a
   * destroyed provider: `destroy()` nulls its persistence, so `open()` builds a
   * fresh doc from markdown and applies the server's updates to something
   * nothing will ever save, possibly against a vault the session no longer owns.
   *
   * Optional so the contract stays "no signal means the caller cannot be torn
   * down mid-drain" — the shape `pullCrdtForNotes` already uses for the same
   * problem. runtime.ts is the only production caller and always passes one.
   */
  signal?: AbortSignal
}

export interface PendingCrdtDrainResult {
  cleared: number
  retained: number
}

interface DrainRequest {
  store: PendingNoteStore
  deps: PendingCrdtDrainDeps
}

/**
 * Serialisation state for the replay. Two runs must never overlap: each one
 * re-reads the durable store at the top and rewrites it at the end, so a second
 * run started mid-flight would re-push notes the first one is already pushing
 * and could write its own id set over the first run's result.
 *
 * The guard used to *drop* the concurrent trigger and return "nothing to do".
 * That leaned on both triggers being idempotent and on something firing the
 * replay again later, and `2d6afbd95` widened the window a trigger can be lost
 * in by making every note pull before it pushes. It defers instead.
 *
 * Deferral *coalesces*: at most one run waits behind the running one. A third
 * trigger asks for nothing the second has not already asked for — every run is
 * "replay whatever the store holds when you start", and that is re-read per run
 * — so a queue of N would be one real pass and N-1 passes over an empty store.
 *
 * The queued run uses the *newest* caller's deps (and store). `deps` closes
 * over one runtime's `engine` and `crdtProvider` (runtime.ts's
 * `replayPendingCrdtNotes`) and neither instance survives `stopSyncRuntime`,
 * so if a session is torn down and a new one starts while a drain is still
 * running, the new session's trigger replaces the dead session's closure
 * rather than queueing behind it.
 *
 * Abort travels with the deps rather than with this module's state, and that is
 * what settles the remaining case. A teardown with nothing replacing it leaves
 * the queued run holding the dead runtime's deps — but that same teardown has
 * already tripped their `signal`, so the deferred run starts, finds itself
 * aborted at its first note and clears nothing. A teardown that *is* followed by
 * a new session has had the deferred request swapped for the live session's,
 * and the live signal is the one that run reads. Aborting the in-flight run
 * while a deferred run begins with a fresh signal is the intended outcome, not
 * a race: every run is "replay whatever the store holds when you start", and
 * the ids the aborted run did not reach are still in the store for the new one
 * to take.
 *
 * The serialisation is process-wide, not per store — every shell has exactly
 * one pending-note store, and that is what makes module state the right home.
 */
let inFlight: Promise<PendingCrdtDrainResult> | null = null
let deferredRun: Promise<PendingCrdtDrainResult> | null = null
let deferredRequest: DrainRequest | null = null

/**
 * Replay the recorded notes. An entry is cleared only once its state has
 * actually reached the server, so a still-offline start leaves it queued for
 * the next attempt rather than losing it.
 *
 * Triggered from two places, both in runtime.ts: the tail of `startSyncRuntime`
 * (cold start and sign-in alike) and the network monitor going online. Coming
 * back from offline does both within the same second, so the returned promise
 * may be for a run deferred behind one already in flight — `{cleared, retained}`
 * always describes the run this call is responsible for, never a run it merely
 * waited on.
 *
 * **Merge before push, and fail closed.** A snapshot push is an assertion that
 * the pushed state contains everything the server has: `storeSnapshot` is
 * followed by `pruneUpdatesBeforeSnapshot`, which deletes every `crdt_updates`
 * row at or below the new snapshot's sequence number. Push a snapshot for a
 * note whose peer edits this device has not merged and those edits are gone
 * from the server and absent from the snapshot — destroyed for every device.
 *
 * Every note here is one this device edited while it could not push, which is
 * exactly the population most likely to have diverged from a peer, so the
 * merge is not optional. It is done per note immediately before that note's
 * push rather than by waiting for the vault sweep: the sweep is paced at 25
 * notes / 15 s, so waiting for it would stall the replay for minutes and still
 * not guarantee a given note had been reached.
 *
 * A merge that does not complete leaves the note pending and unpushed. Delaying
 * one device's backlog is recoverable; deleting another device's edits is not.
 *
 * A merge that completed but skipped a payload whose signer could not be
 * resolved is a third case, and it is NOT held back here: that skip can be
 * permanent, so waiting for it would delay the backlog forever. `pushSnapshot`
 * answers it by sending the same doc state to the incremental endpoint, which
 * prunes nothing — see the endpoint choice in `runtime.ts`.
 */
export function drainPendingNotes(
  store: PendingNoteStore,
  deps: PendingCrdtDrainDeps
): Promise<PendingCrdtDrainResult> {
  if (!inFlight) return startDrain({ store, deps })

  deferredRequest = { store, deps }
  deferredRun ??= runAfter(inFlight)
  return deferredRun
}

async function runAfter(
  previous: Promise<PendingCrdtDrainResult>
): Promise<PendingCrdtDrainResult> {
  // A predecessor that threw is not a reason to skip this run: the trigger
  // behind it is an independent attempt, not a retry of that one.
  await previous.catch(() => undefined)
  const request = deferredRequest!
  deferredRequest = null
  deferredRun = null
  return startDrain(request)
}

function startDrain(request: DrainRequest): Promise<PendingCrdtDrainResult> {
  const run = drainOnce(request).finally(() => {
    // Stay marked in-flight while a run is queued behind this one. The handoff
    // in `runAfter` is asynchronous, and a trigger landing inside it has to join
    // that run rather than start a third drain alongside it.
    if (inFlight === run && !deferredRun) inFlight = null
  })
  inFlight = run
  return run
}

async function drainOnce({ store, deps }: DrainRequest): Promise<PendingCrdtDrainResult> {
  // Re-read per run, so a run deferred behind another one picks up the ids that
  // one recorded while it was working as well as the ones it could not clear.
  const pending = store.read()
  if (pending.length === 0) return { cleared: 0, retained: 0 }

  const cleared: string[] = []
  let aborted = false
  try {
    for (const noteId of pending) {
      // The runtime whose engine and provider these deps close over is gone.
      // Stop here rather than at the end of the pass: every remaining note would
      // be worked against destroyed objects, and the ids stay in the store.
      if (deps.signal?.aborted) {
        aborted = true
        break
      }
      try {
        if (!deps.isSyncable(noteId)) {
          cleared.push(noteId)
          continue
        }
        // Checked again, and this is the check that matters. `isSyncable` is the
        // caller's code — today it reaches the index database, which `closeVault`
        // closes — so control can spend real time between the top of the
        // iteration and here, and the loop awaits twice per note besides. The
        // merge is the destructive half: it opens the note on the caller's
        // CrdtProvider, and a destroyed provider has no persistence, so the
        // server state it applies lands in a doc nothing will ever save.
        if (deps.signal?.aborted) {
          aborted = true
          break
        }
        if (!(await deps.mergeRemote(noteId))) {
          log.warn('Not replaying a CRDT note whose server state did not merge', { noteId })
          continue
        }
        if (await deps.pushSnapshot(noteId)) cleared.push(noteId)
      } catch (err) {
        // Per note, not per pass — the shape `applyCrdtBatchChunk` already uses.
        // `isSyncable` is inside this try on purpose: `closeVault` calls
        // `closeAllDatabases()`, after which `validateNoteForCrdt` throws for
        // every remaining id, and one throw used to abandon the whole drain.
        // A note that threw is not cleared, so the next pass retries it.
        log.warn('Failed to replay a pending CRDT note', { noteId, error: err })
      }
    }
  } finally {
    // Abort or not, only ids whose state actually reached the server — or that
    // resolve to nothing to send — are cleared. Everything this run did not get
    // to stays in the durable store for the next session, which is the whole
    // reason stopping early is safe.
    store.clear(cleared)
  }

  const retained = pending.length - cleared.length
  if (aborted) {
    // Distinct from the warning below on purpose: this is an expected teardown,
    // not a device that cannot reach the server, and log triage greps these.
    log.info('Stopped replaying CRDT notes: the sync runtime that started the replay is gone', {
      cleared: cleared.length,
      retained
    })
  } else if (retained > 0) {
    log.warn('Some CRDT notes buffered at shutdown still have not synced', {
      cleared: cleared.length,
      retained
    })
  } else {
    log.info('Replayed CRDT notes buffered at shutdown', { cleared: cleared.length })
  }
  return { cleared: cleared.length, retained }
}
