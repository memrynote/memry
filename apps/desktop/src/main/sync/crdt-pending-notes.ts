import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtPendingNotes')

const FILE_NAME = 'crdt-pending-notes.json'

/**
 * Durable record of notes whose CRDT updates never reached the server.
 *
 * Two things fill it, and they are not the same case:
 *
 *  - The in-memory update queue no-ops its flush while paused (offline,
 *    expired token, quota), so quitting in that state used to discard
 *    everything buffered: the edits stayed on this device but silently never
 *    synced. Same for the notes its memory budget releases.
 *  - Local edits made with no update queue at all — signed out, unpaid, or
 *    before the vault opens. The queue never sees those, so its shutdown path
 *    cannot record them; `CrdtProvider.recordUnqueuedUpdate` does it instead,
 *    as the edits happen.
 *
 * The updates themselves are already durable either way — the CRDT provider
 * persists every one of them to the local store — so only the note ids need to
 * survive. `drainPendingCrdtNotes` pushes each note's full doc state, which
 * strictly supersedes any individual buffered updates and is the *only* shape
 * available for a queue-less edit, which produced no incrementals at all.
 */

function storePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

export function readPendingCrdtNotes(): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(storePath(), 'utf8')
  } catch {
    // No file is the normal case — nothing was ever left unflushed.
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch (err) {
    log.warn('Pending CRDT note store is unreadable, ignoring it', { error: err })
    return []
  }
}

function writePendingCrdtNotes(noteIds: string[]): void {
  try {
    if (noteIds.length === 0) {
      fs.rmSync(storePath(), { force: true })
      return
    }
    fs.writeFileSync(storePath(), JSON.stringify(noteIds), 'utf8')
  } catch (err) {
    log.error('Failed to write the pending CRDT note store', { error: err })
  }
}

/**
 * Add note ids to the durable set. Synchronous on purpose: one caller is the
 * update queue's `stop()`, which runs while the process is quitting and cannot
 * await anything. The provider's queue-less recorder relies on the same
 * property — the id is on disk before the call returns, so a crash a keystroke
 * later still replays — and dedupes per note so this stays one small write per
 * note touched rather than one per update.
 */
export function recordPendingCrdtNotes(noteIds: string[]): void {
  if (noteIds.length === 0) return
  const merged = new Set(readPendingCrdtNotes())
  for (const noteId of noteIds) merged.add(noteId)
  writePendingCrdtNotes(Array.from(merged))
}

export function clearPendingCrdtNotes(noteIds: string[]): void {
  if (noteIds.length === 0) return
  const done = new Set(noteIds)
  writePendingCrdtNotes(readPendingCrdtNotes().filter((noteId) => !done.has(noteId)))
}

export interface PendingCrdtDrainDeps {
  /**
   * Pull this note's server state and merge it into the local doc. `false`
   * means the merge did not complete, and the snapshot must NOT be pushed —
   * see the ordering note on `drainPendingCrdtNotes`.
   */
  mergeRemote: (noteId: string) => Promise<boolean>
  /** Push the note's full CRDT state to the server. `false` means try again. */
  pushSnapshot: (noteId: string) => Promise<boolean>
  /** `false` for notes that no longer exist or never sync via CRDT (binaries). */
  isSyncable: (noteId: string) => boolean
}

interface PendingCrdtDrainResult {
  cleared: number
  retained: number
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
 * The queued run uses the *newest* caller's deps. `deps` closes over one
 * runtime's `engine` and `crdtProvider` (runtime.ts's `replayPendingCrdtNotes`)
 * and neither instance survives `stopSyncRuntime`, so if a session is torn down
 * and a new one starts while a drain is still running, the new session's
 * trigger replaces the dead session's closure rather than queueing behind it.
 *
 * A teardown with nothing replacing it leaves the queued run holding the dead
 * runtime's deps — the same exposure a drain already in flight has, since
 * teardown does not await it. It fails closed: `CrdtProvider.destroy()` nulls
 * `snapshotPushFn`, and `pushSnapshotForNote` returns false without one, so
 * nothing is cleared and every id stays in the durable store for next session.
 */
let inFlight: Promise<PendingCrdtDrainResult> | null = null
let deferredRun: Promise<PendingCrdtDrainResult> | null = null
let deferredDeps: PendingCrdtDrainDeps | null = null

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
export function drainPendingCrdtNotes(deps: PendingCrdtDrainDeps): Promise<PendingCrdtDrainResult> {
  if (!inFlight) return startDrain(deps)

  deferredDeps = deps
  deferredRun ??= runAfter(inFlight)
  return deferredRun
}

async function runAfter(
  previous: Promise<PendingCrdtDrainResult>
): Promise<PendingCrdtDrainResult> {
  // A predecessor that threw is not a reason to skip this run: the trigger
  // behind it is an independent attempt, not a retry of that one.
  await previous.catch(() => undefined)
  const deps = deferredDeps!
  deferredDeps = null
  deferredRun = null
  return startDrain(deps)
}

function startDrain(deps: PendingCrdtDrainDeps): Promise<PendingCrdtDrainResult> {
  const run = drainOnce(deps).finally(() => {
    // Stay marked in-flight while a run is queued behind this one. The handoff
    // in `runAfter` is asynchronous, and a trigger landing inside it has to join
    // that run rather than start a third drain alongside it.
    if (inFlight === run && !deferredRun) inFlight = null
  })
  inFlight = run
  return run
}

async function drainOnce(deps: PendingCrdtDrainDeps): Promise<PendingCrdtDrainResult> {
  // Re-read per run, so a run deferred behind another one picks up the ids that
  // one recorded while it was working as well as the ones it could not clear.
  const pending = readPendingCrdtNotes()
  if (pending.length === 0) return { cleared: 0, retained: 0 }

  const cleared: string[] = []
  try {
    for (const noteId of pending) {
      if (!deps.isSyncable(noteId)) {
        cleared.push(noteId)
        continue
      }
      try {
        if (!(await deps.mergeRemote(noteId))) {
          log.warn('Not replaying a CRDT note whose server state did not merge', { noteId })
          continue
        }
        if (await deps.pushSnapshot(noteId)) cleared.push(noteId)
      } catch (err) {
        log.warn('Failed to replay a pending CRDT note', { noteId, error: err })
      }
    }
  } finally {
    clearPendingCrdtNotes(cleared)
  }

  const retained = pending.length - cleared.length
  if (retained > 0) {
    log.warn('Some CRDT notes buffered at shutdown still have not synced', {
      cleared: cleared.length,
      retained
    })
  } else {
    log.info('Replayed CRDT notes buffered at shutdown', { cleared: cleared.length })
  }
  return { cleared: cleared.length, retained }
}
