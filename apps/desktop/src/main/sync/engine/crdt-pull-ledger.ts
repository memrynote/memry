/**
 * The per-note pull queue and unmerged flags of the CRDT sync coordinator, and
 * their durable half, `crdt_body_debts` (#2297). Split out of
 * `CrdtSyncCoordinator` for size; the coordinator extends it, so every caller
 * keeps the same methods.
 */
import { NetworkError, SyncServerError } from '@memry/sync-client/http-errors'
import { DeadLetterError } from '@memry/sync-client/retry'
import type { SyncContext } from './sync-context'
import type { CrdtBodyDebtReason, CrdtBodyDebtStore } from './crdt-body-debts'

/**
 * The notes one pass has already counted a failed pull for: a pass counts at
 * most one failure per note (#2297 review A-2, B-M1).
 */
export type PassFailures = Set<string>

/**
 * A real failed body pull, raised by the note's own request: a server answer
 * other than a rate limit or an expired session, or a payload that would not
 * decrypt. An abort, an outage, a timeout, pacing, and anything raised after
 * `signal` aborted (a teardown) say nothing about the note, so they never back
 * it off. A dead letter is judged by the error it gave up on (#2297 round 2).
 */
export function isFailedBodyPull(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  const cause = err instanceof DeadLetterError ? err.lastError : err
  if (
    cause instanceof DOMException &&
    (cause.name === 'AbortError' || cause.name === 'TimeoutError')
  ) {
    return false
  }
  if (cause instanceof NetworkError) return false
  if (cause instanceof SyncServerError) return cause.statusCode !== 429 && cause.statusCode !== 401
  return true
}

export class CrdtPullLedger {
  protected pendingPulls = new Set<string>()
  /**
   * Owed notes waiting out a failure backoff (`crdtBodyDebtBackoffMs`). Kept
   * apart from `pendingPulls`, so a clean walk from any path settles them and
   * the sweep-stamp and legacy `done` gates do not wait on them.
   */
  protected deferredPulls = new Set<string>()
  /**
   * Called when a counted failure defers a note, so the runner can arm the
   * timer that retries it once its backoff ends (#2297 round 2 a-M1).
   */
  onDeferred: (() => void) | null = null
  /**
   * The generation a session-only flag was raised at. A walk that captured an
   * older generation did not see what raised it, so it may not clear it
   * (#2297 round 2 b-L4). Durable flags carry theirs in the row.
   */
  private sessionFlagGenerations = new Map<string, number>()
  /**
   * Notes this device knows it has NOT merged the server's state for.
   *
   * A snapshot push is an assertion that the pushed doc contains everything the
   * server holds: `storeSnapshot` overwrites the note's single R2 blob and
   * `pruneUpdatesBeforeSnapshot` then deletes every `crdt_updates` row at or
   * below the stored watermark — every device's rows, not just this one's. So
   * the assertion is a lie for any note whose remote state this device has not
   * actually taken in, and the peer edits it destroys are absent from the
   * snapshot replacing them. That is #1503, and #1489 is one slice of it.
   *
   * Membership is therefore "known-unmerged", not "unverifiable signer":
   *
   *   - a merge pass that skipped a payload whose signer could not be resolved
   *     (#1489 — the payload is sealed with a file key wrapped by the vault
   *     key, so the signer key is only ever a *signature* check and a skipped
   *     update still holds recoverable user content);
   *   - a merge pass that failed outright — rate-limited or failed baseline,
   *     failed or dead-lettered incrementals, an aborted pass, missing token or
   *     vault key, a doc that would not open;
   *   - a note the server named in a `crdt_updated` broadcast, or that a
   *     vault-wide sweep queued, before its pull has run.
   *
   * Refusing to push at all is not an option for any of them. An unresolvable
   * signer can be permanent — `GET /auth/devices` only lists non-revoked
   * devices, so a revoked peer's key never comes back — and an unmergeable note
   * held back forever strands this device's own edits forever, trading a rare
   * loss for a certain one. So the note is flagged instead and the push path
   * routes it away from the snapshot endpoint, which is the only thing that
   * prunes. `/sync/crdt/updates` stores and broadcasts the same doc state and
   * prunes nothing.
   *
   * This is deliberately NOT `pendingPulls`. That set is emptied by
   * `drainPendingPulls()` at the top of a cycle and refilled only when a pull
   * fails, so a note is in it for neither the seconds nor the minutes it spends
   * queued in the paced sweep and actually being pulled — precisely the window
   * #1503 loses data in. This set is raised whenever a note enters `pendingPulls`
   * and cleared only by a pass that walked the note end to end.
   *
   * Every flag raised on evidence is also a row in `crdt_body_debts` (#2297),
   * written before the cursor can move past that evidence, and `hydrateBodyDebts`
   * fills this set and `pendingPulls` from the table at engine start. A flag
   * raised by a speculative sweep, by a broadcast once the legacy sweep is
   * done, or by a rate-limited pull of a note with no debt has no row: it
   * describes no known state, so a restart may drop it.
   */
  protected unmergedRemoteNotes = new Set<string>()

  /** The durable half of the two sets above; see `crdt-body-debts.ts`. */
  protected debts: CrdtBodyDebtStore

  constructor(
    protected ctx: SyncContext,
    debts: CrdtBodyDebtStore
  ) {
    this.debts = debts
  }

  /**
   * Queue a whole-body pull for a note this device knows is unmerged, and owe
   * it durably. A note queued for a pull is by definition a note whose server
   * state is not in the local doc yet. It stays flagged across the drain into
   * the paced sweep queue and across the pull itself, because that whole span
   * is time in which a snapshot push would prune rows this device never read.
   * `lowestCursor` is the lowest change-feed cursor of an entry the note may
   * lack, when a feed entry raised the debt.
   */
  addPendingPull(
    noteId: string,
    reason: CrdtBodyDebtReason,
    lowestCursor: number | null = null
  ): void {
    this.pendingPulls.add(noteId)
    this.unmergedRemoteNotes.add(noteId)
    this.debts.owe([noteId], reason, { lowestCursor })
  }

  /**
   * Queue pulls, flagged. Session-only unless `durableReason` is given: a
   * speculative sweep is not evidence that a note is unmerged, and a broadcast
   * the feed re-serves after a crash needs no row (#2297).
   */
  queuePulls(noteIds: readonly string[], durableReason?: CrdtBodyDebtReason): void {
    for (const noteId of noteIds) {
      this.pendingPulls.add(noteId)
      this.unmergedRemoteNotes.add(noteId)
    }
    if (durableReason) this.debts.owe(noteIds, durableReason)
  }

  /**
   * Record that this note holds server state the local doc does not, without
   * queueing a pull.
   *
   * For the `crdt_updated` broadcast that is pulled immediately rather than
   * queued: the server has just named the note, so the state is unmerged from
   * that moment until that pull completes cleanly. Going through
   * `addPendingPull` there instead would buy the note a redundant second pull
   * in the next sweep. `durable` is false once the legacy sweep is done: the
   * feed then re-serves the body above `LAST_CURSOR` after a crash.
   */
  markRemoteStateUnmerged(noteId: string, durable = true): void {
    if (durable) {
      this.unmergedRemoteNotes.add(noteId)
      this.debts.owe([noteId], 'broadcast')
    } else {
      this.flagRemoteStateUnmerged(noteId)
    }
  }

  /**
   * Flag a note for this session only, with no pull and no durable debt: a
   * queued full-state row at runtime start (#2299). The row itself is durable
   * and flags the note again at every start; its own flush pull clears it.
   */
  flagRemoteStateUnmerged(noteId: string): void {
    this.unmergedRemoteNotes.add(noteId)
    this.sessionFlagGenerations.set(noteId, this.debts.bumpGeneration())
  }

  /**
   * Owe an applied note or journal record its whole body, before the CRDT
   * batch that pays it runs and before the pull cursor can move past it
   * (#2294, #2297). On a record page this runs inside the page transaction, so
   * the debt commits with the record. The batch clears it with a clean walk; a
   * crash first leaves the row for the next engine. Local-only notes are
   * skipped: no walk would ever clear their debt.
   */
  oweRecordBody(noteId: string): void {
    const provider = this.ctx.deps.crdtProvider
    if (!provider || provider.isNoteLocalOnly(noteId)) return
    this.unmergedRemoteNotes.add(noteId)
    this.debts.owe([noteId], 'record')
  }

  /**
   * Owe a note whose change-feed entries were skipped because its record is on
   * the page (#2297 review B-H1), inside the page transaction. No pull is
   * queued: the record's own CRDT batch walks the note and settles this. A
   * record that fails to apply leaves the note owed and flagged, so it never
   * claims the cursor the page moves to.
   */
  oweSkippedBody(noteId: string, lowestCursor: number | null): void {
    this.unmergedRemoteNotes.add(noteId)
    this.debts.owe([noteId], 'feed_owed', { lowestCursor })
  }

  /**
   * Engine start: every debt a previous session left becomes a queued pull and
   * a flag again. The first full sync's drain pays it, or defers it until its
   * failure backoff ends; no snapshot push prunes around it first.
   */
  hydrateBodyDebts(): number {
    const debts = this.debts.list()
    for (const { noteId } of debts) {
      this.pendingPulls.add(noteId)
      this.unmergedRemoteNotes.add(noteId)
    }
    return debts.length
  }

  /**
   * Re-queue a note whose pull did not complete, so the NEXT cycle retries it.
   *
   * Every failure path below used to end at a `log.warn`, which meant a note the
   * server rate-limited kept its stale body until the next vault-wide sweep —
   * gated at a 60s reconnect floor or a 15-minute interval — and opening the
   * note did not help, because that reads main's Y.Doc rather than the server.
   * A whole-vault sweep that trips the limit therefore lost most of its notes
   * silently.
   *
   * The debt is deliberately paid by the next cycle rather than in place. The
   * pull loops are serial and run with `retryOn429: false` on purpose: honouring
   * a `Retry-After` of up to 60s three times over would stall every remaining
   * note in the pass on one rate-limited note.
   *
   * `failures` names the pass when this is a real failed body pull (a server
   * error, an unverifiable signer): the durable debt counts one failure per
   * note per pass, and the drain backs off from it. Aborts, missing
   * credentials and rate limits pass none: they are retried next cycle, and
   * they re-owe a durable debt only where one already stands.
   *
   * It also raises `unmergedRemoteNotes`: a failed merge is the state #1503
   * destroys data from, and the flag is what keeps the note's pushes off the
   * pruning endpoint until a pass actually completes.
   */
  protected owePendingPull(noteId: string, failures?: PassFailures, needsWalk = false): void {
    const counted = failures !== undefined
    const failed = counted && !failures.has(noteId)
    failures?.add(noteId)
    this.unmergedRemoteNotes.add(noteId)
    // Only a failed body pull is evidence about the note, so only it writes a
    // new row; pacing noise re-owes an existing debt and otherwise stays in
    // this session (#2297 review).
    this.debts.owe([noteId], 'pull_failed', { failed, existingOnly: !counted, needsWalk })
    if (!counted) {
      this.pendingPulls.add(noteId)
      return
    }
    // Deferred when counted, not at the next drain: a failing note left in
    // `pendingPulls` would hold the sweep stamp and the legacy `done` until
    // some later drain moved it (#2297 round 2 a-M1).
    this.pendingPulls.delete(noteId)
    this.deferredPulls.add(noteId)
    this.onDeferred?.()
  }

  /**
   * An update the provider dropped (its doc was closing): the doc lacks it,
   * and the watermark may already claim it, so only a walk may settle the
   * debt. Not a failure of the note, so it counts nothing (#2297 round 2 b-M3).
   */
  protected oweDroppedUpdate(noteId: string): void {
    this.pendingPulls.add(noteId)
    this.unmergedRemoteNotes.add(noteId)
    this.debts.owe([noteId], 'pull_failed', { needsWalk: true })
  }

  /**
   * The queued pulls a drain may run now. A debt whose pulls keep failing waits
   * out its backoff in `deferredPulls`, still flagged, so an unverifiable signer
   * does not cost a pull every full sync; `nextDeferredPullAt` says when.
   */
  drainPendingPulls(now = Date.now()): string[] {
    const backoffUntil = this.debts.backoffUntil()
    const ready: string[] = []
    for (const noteId of [...this.pendingPulls, ...this.deferredPulls]) {
      this.pendingPulls.delete(noteId)
      if ((backoffUntil.get(noteId) ?? 0) > now) {
        this.deferredPulls.add(noteId)
        continue
      }
      this.deferredPulls.delete(noteId)
      ready.push(noteId)
    }
    return ready
  }

  /** When the earliest deferred pull's backoff ends, or null with none deferred. */
  nextDeferredPullAt(): number | null {
    if (this.deferredPulls.size === 0) return null
    const backoffUntil = this.debts.backoffUntil()
    let next: number | null = null
    for (const noteId of this.deferredPulls) {
      const until = backoffUntil.get(noteId) ?? 0
      if (next === null || until < next) next = until
    }
    return next
  }

  /** Hand the deferred pulls back to the next drain, which re-checks each backoff. */
  requeueDeferredPulls(): void {
    for (const noteId of this.deferredPulls) this.pendingPulls.add(noteId)
    this.deferredPulls.clear()
  }

  get pendingPullCount(): number {
    return this.pendingPulls.size
  }

  /**
   * Does this note hold server state this device has not merged into its doc?
   *
   * `true` means a snapshot push for this note would destroy that state:
   * `storeSnapshot` overwrites the note's single R2 snapshot blob and
   * `pruneUpdatesBeforeSnapshot` then deletes every `crdt_updates` row at or
   * below the stored watermark — including the rows this device never read,
   * which are by definition absent from the snapshot replacing them. Pushing
   * the same doc state to `/sync/crdt/updates` instead has neither effect.
   */
  hasUnmergedRemoteState(noteId: string): boolean {
    return this.unmergedRemoteNotes.has(noteId)
  }

  /**
   * A pass walked these notes' whole server bodies into their docs, each
   * without an unverified or failed update. A pass is only allowed to clear the
   * flag it did not raise, so a pass that throws half-way leaves the
   * conservative answer standing rather than a stale "safe".
   *
   * `pendingPulls` is consulted too, and it closes the last window: something
   * else — a `crdt_updated` broadcast, a sibling failure path — may have owed
   * the note a pull while the pass was in flight, and that pull's payload is by
   * definition not in the doc this pass just finished walking. A note waiting
   * out a backoff is not in it: this walk is the pull it was waiting for.
   *
   * The durable debts are settled in one transaction, guarded on the
   * generation the pass captured when it started: a debt raised while it ran
   * stands, and so does the flag. A clean walk also lets a doc seeded or
   * created without persisted state claim again (#2299,
   * `CrdtProvider.recordWholeBodyMerged`).
   */
  protected settleMergedNotes(noteIds: readonly string[], generation: number): void {
    const clean = noteIds.filter(
      (noteId) =>
        !this.pendingPulls.has(noteId) &&
        (this.sessionFlagGenerations.get(noteId) ?? 0) <= generation
    )
    if (clean.length === 0) return
    const stillOwed = this.debts.settle(clean, generation)
    for (const noteId of clean) {
      this.ctx.deps.crdtProvider?.recordWholeBodyMerged(noteId)
      if (stillOwed.has(noteId)) continue
      this.unmergedRemoteNotes.delete(noteId)
      this.deferredPulls.delete(noteId)
      this.sessionFlagGenerations.delete(noteId)
    }
  }

  /**
   * A note no pass will walk (deleted, local-only): its session flag may not
   * stand. A durable debt it holds is left alone: a deleted note's is settled
   * by the drain's rowless drop, a local-only note's once the toggle is off.
   */
  clearUnmergedForDroppedNote(noteId: string): void {
    if (this.pendingPulls.has(noteId)) return
    this.unmergedRemoteNotes.delete(noteId)
    this.sessionFlagGenerations.delete(noteId)
  }

  /**
   * The queued ids of notes with no row left are settled without a pull: the
   * owed note was deleted, and nothing will ever pull it (#2297).
   */
  protected dropRowless(noteIds: readonly string[]): void {
    const dropped = noteIds.filter((noteId) => !this.pendingPulls.has(noteId))
    if (dropped.length === 0) return
    const stillOwed = this.debts.settle(dropped)
    for (const noteId of dropped) {
      if (stillOwed.has(noteId)) continue
      this.unmergedRemoteNotes.delete(noteId)
      this.deferredPulls.delete(noteId)
      this.sessionFlagGenerations.delete(noteId)
    }
  }

  /** Teardown: memory only. The debts stay for the next engine to hydrate. */
  protected clearPullLedger(): void {
    this.pendingPulls.clear()
    this.deferredPulls.clear()
    this.unmergedRemoteNotes.clear()
    this.sessionFlagGenerations.clear()
  }
}
