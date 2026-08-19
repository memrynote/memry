import { createLogger } from '../../lib/logger'
import { secureCleanup } from '../../crypto/index'
import { withRetry } from '../retry'
import {
  getFromServer,
  postToServer,
  fetchCrdtSnapshot,
  type CrdtBatchPullResponse
} from '../http-client'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import { trackMainError } from '../../telemetry/diagnostics'
import type { SyncContext } from './sync-context'

const log = createLogger('CrdtSyncCoordinator')

export type ResolveDeviceKey = (deviceId: string) => Promise<Uint8Array | null>

export class CrdtSyncCoordinator {
  private ctx: SyncContext
  private pendingPulls = new Set<string>()
  private lastAppliedSequence = new Map<string, number>()
  private resolveDeviceKey: ResolveDeviceKey
  /** Once per key per session — CRDT apply failures recur every pass and would storm otherwise. */
  private applyFailureReported = new Set<string>()
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
   */
  private unmergedRemoteNotes = new Set<string>()

  /**
   * Told when the set above goes from empty to non-empty and back.
   *
   * The set cannot be its own durable record: it is per session and
   * `clearCaches()` empties it at teardown, so a note left unmerged at quit came
   * back unflagged on the next launch — and unflagged is the answer that lets a
   * snapshot push prune the peer rows this device never read. Nor does the next
   * launch necessarily re-raise it: the vault-wide sweep is throttled against a
   * *persisted* stamp, so a restart inside that interval queues nothing.
   *
   * Only the fact that debt exists travels; which notes it was does not.
   * `FullSyncRunner` persists this and answers every note conservatively until
   * a sweep has flagged them individually again, which is both cheaper than a
   * durable id set and strictly safer than one — an id set could still be
   * missing whatever the crash did not get to write.
   */
  onUnmergedDebtChange?: (hasDebt: boolean) => void
  /** Last value handed to `onUnmergedDebtChange`, so only transitions are sent. */
  private reportedUnmergedDebt = false

  constructor(ctx: SyncContext, resolveDeviceKey: ResolveDeviceKey) {
    this.ctx = ctx
    this.resolveDeviceKey = resolveDeviceKey
  }

  addPendingPull(noteId: string): void {
    this.pendingPulls.add(noteId)
    // A note queued for a pull is by definition a note whose server state is
    // not in the local doc yet. It stays flagged across the drain into the
    // paced sweep queue and across the pull itself, because that whole span is
    // time in which a snapshot push would prune rows this device never read.
    this.markRemoteStateUnmerged(noteId)
  }

  /**
   * Record that this note holds server state the local doc does not, without
   * queueing a pull.
   *
   * For the `crdt_updated` broadcast that is pulled immediately rather than
   * queued: the server has just named the note, so the state is unmerged from
   * that moment until that pull completes cleanly. Going through
   * `addPendingPull` there instead would buy the note a redundant second pull
   * in the next sweep.
   */
  markRemoteStateUnmerged(noteId: string): void {
    this.unmergedRemoteNotes.add(noteId)
    this.reportUnmergedDebt()
  }

  /** Does this device hold debt for any note at all? */
  get hasUnmergedNotes(): boolean {
    return this.unmergedRemoteNotes.size > 0
  }

  private reportUnmergedDebt(): void {
    const hasDebt = this.unmergedRemoteNotes.size > 0
    if (hasDebt === this.reportedUnmergedDebt) return
    this.reportedUnmergedDebt = hasDebt
    this.onUnmergedDebtChange?.(hasDebt)
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
   * note in the pass on one rate-limited note. Nor is this failure-kind-specific
   * — a transient 5xx, an unreachable server and a 429 all leave the same stale
   * body, and "failed, so retry next cycle" needs no taxonomy to be correct.
   *
   * It also raises `unmergedRemoteNotes`, via `addPendingPull`: a failed merge
   * is the state #1503 destroys data from, and the flag is what keeps the note's
   * pushes off the pruning endpoint until a pass actually completes.
   */
  private owePendingPull(noteId: string): void {
    this.addPendingPull(noteId)
  }

  drainPendingPulls(): string[] {
    const ids = Array.from(this.pendingPulls)
    this.pendingPulls.clear()
    return ids
  }

  get pendingPullCount(): number {
    return this.pendingPulls.size
  }

  /**
   * Both maps hold one entry per note ever CRDT-synced — i.e. the whole vault
   * after the first full sync — so they must not outlive the engine that filled
   * them. Dropping `lastAppliedSequence` is safe: the next pass re-derives its
   * `since` cursor from the server snapshot baseline, and re-applying a CRDT
   * update is a no-op.
   */
  clearCaches(): void {
    this.pendingPulls.clear()
    this.lastAppliedSequence.clear()
    this.applyFailureReported.clear()
    // Deliberately silent: `reportUnmergedDebt` is not called here. This is a
    // teardown, not a note that finished merging, and reporting "no debt" for it
    // would erase the durable record of debt that outlives the session — which
    // is the whole thing that record exists to carry.
    this.unmergedRemoteNotes.clear()
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
   * A pass is only allowed to clear the flag it did not raise. Skips and
   * failures are recorded the moment they happen and cleared only once a pass
   * has walked a note end to end without one, so a pass that throws half-way
   * leaves the conservative answer standing rather than a stale "safe".
   *
   * `pendingPulls` is consulted too, and it closes the last window: something
   * else — a `crdt_updated` broadcast, a sibling failure path — may have owed
   * this note a pull while the pass was in flight, and that pull's payload is
   * by definition not in the doc this pass just finished walking. Clearing on
   * the pass's own clean result alone would call such a note safe to snapshot.
   */
  private clearUnmergedIfClean(noteId: string, sawUnmerged: boolean): void {
    if (sawUnmerged || this.pendingPulls.has(noteId)) return
    if (this.unmergedRemoteNotes.delete(noteId)) this.reportUnmergedDebt()
  }

  private rememberAppliedSequence(noteId: string, sequenceNum: number): number {
    const known = this.lastAppliedSequence.get(noteId) ?? 0
    const next = Math.max(known, sequenceNum)
    this.lastAppliedSequence.set(noteId, next)
    return next
  }

  /**
   * `verified: false` means the server's snapshot for this note was left out of
   * the local doc. The caller has to carry that up: a snapshot push would
   * overwrite the very blob that was skipped.
   */
  private async applySnapshotBaseline(
    noteId: string,
    token: string,
    vaultKey: Uint8Array,
    mode: 'single' | 'batch'
  ): Promise<{ since: number; verified: boolean }> {
    const snapshotResult = await fetchCrdtSnapshot(noteId, token)
    if (!snapshotResult || !this.ctx.deps.crdtProvider) {
      return { since: 0, verified: true }
    }

    const signerPubKey = await this.resolveDeviceKey(snapshotResult.signerDeviceId)
    if (!signerPubKey) {
      log.warn(`Skipping CRDT snapshot from unresolvable signer in ${mode} mode`, {
        noteId,
        signerDeviceId: snapshotResult.signerDeviceId
      })
      return { since: 0, verified: false }
    }

    const decrypted = decryptCrdtUpdate(snapshotResult.snapshot, vaultKey, noteId, signerPubKey)
    this.ctx.deps.crdtProvider.applyRemoteUpdate(noteId, decrypted)
    const baselineSequence = this.rememberAppliedSequence(noteId, snapshotResult.sequenceNum)
    log.debug('Applied CRDT snapshot baseline', {
      noteId,
      mode,
      sequenceNum: snapshotResult.sequenceNum
    })
    return { since: baselineSequence, verified: true }
  }

  /**
   * Returns whether this note's server state was fully merged into the local
   * doc. Every caller before the pending-note replay ignored it — a failure is
   * owed a retry and reported, and that was the whole contract. The replay
   * cannot ignore it: pushing a snapshot tells the server "I contain everything
   * up to here" and it acts on that by deleting the peer's incrementals, so a
   * push on top of an incomplete merge destroys them. `false` therefore has to
   * mean "do not push", which makes every early return below a `false` too.
   *
   * An update skipped for an unresolvable signer is deliberately NOT a `false`.
   * That skip can be permanent, so `false` would hold this note back forever and
   * trade a rare loss for a certain one. It is recorded in
   * `unmergedRemoteNotes` instead, and the push path answers it by sending the
   * doc state to the incremental endpoint, which prunes nothing.
   *
   * Every `false` below is recorded there too. Failing closed only protects the
   * one caller that reads the return value (the pending-note replay); the 30s
   * snapshot scheduler and every other push path never see it, so the flag is
   * what carries an incomplete merge to them.
   */
  async applyCrdtIncrementals(
    noteId: string,
    token: string,
    vaultKey: Uint8Array,
    signal?: AbortSignal
  ): Promise<boolean> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider) return false

    const effectiveSignal = signal ?? this.ctx.abortController?.signal
    if (!effectiveSignal) return false

    const wasOpen = crdtProvider.getDoc(noteId) != null
    try {
      const doc = await crdtProvider.open(noteId, undefined, { skipSeed: true })
      if (!doc) {
        this.owePendingPull(noteId)
        return false
      }

      // This pass IS the pull the note may already have been owed, so the debt
      // is settled here rather than at the end. That is what lets
      // `clearUnmergedIfClean` tell "still owed from before" from "owed again
      // while this pass ran": a `crdt_updated` broadcast or a sibling failure
      // landing mid-pass leaves an entry this pass did not put there, and the
      // note stays flagged. Every failure path below re-owes it.
      this.pendingPulls.delete(noteId)

      const baseline = await this.applySnapshotBaseline(noteId, token, vaultKey, 'single')
      let since = baseline.since
      let sawUnmerged = !baseline.verified
      // Owed a pull as well as flagged, matching the batch path: a signer that
      // was only transiently unresolvable then clears the flag on a later pass
      // rather than costing this note its compaction point for the session.
      if (sawUnmerged) this.owePendingPull(noteId)

      let hasMore = true

      while (hasMore) {
        if (effectiveSignal.aborted) {
          log.debug('applyCrdtIncrementals aborted', { noteId, lastSeq: since })
          this.owePendingPull(noteId)
          return false
        }

        const result = await withRetry(
          () =>
            getFromServer<{
              updates: Array<{
                sequenceNum: number
                data: string
                createdAt: number
                signerDeviceId: string
              }>
              hasMore: boolean
            }>(
              `/sync/crdt/updates?note_id=${encodeURIComponent(noteId)}&since=${since}&limit=100`,
              token
            ),
          { maxRetries: 3, baseDelayMs: 2000, signal: effectiveSignal, retryOn429: false }
        ).then((r) => r.value)

        log.debug('applyCrdtIncrementals fetched', {
          noteId,
          since,
          updateCount: result.updates.length,
          hasMore: result.hasMore
        })

        const signerIds = new Set(result.updates.map((u) => u.signerDeviceId))
        await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))

        for (const entry of result.updates) {
          const bin = atob(entry.data)
          const packed = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i)

          const signerPubKey = await this.resolveDeviceKey(entry.signerDeviceId)
          if (!signerPubKey) {
            log.warn('Skipping CRDT update from unresolvable signer', {
              noteId,
              signerDeviceId: entry.signerDeviceId,
              sequenceNum: entry.sequenceNum
            })
            // Flagged before the loop can throw, and the note is owed another
            // pull: a signer that becomes resolvable (a token that was simply
            // expired here) clears the flag on the next pass.
            sawUnmerged = true
            this.owePendingPull(noteId)
            since = entry.sequenceNum
            continue
          }

          const decrypted = decryptCrdtUpdate(packed, vaultKey, noteId, signerPubKey)
          crdtProvider.applyRemoteUpdate(noteId, decrypted)
          since = this.rememberAppliedSequence(noteId, entry.sequenceNum)
        }

        hasMore = result.hasMore
      }

      this.clearUnmergedIfClean(noteId, sawUnmerged)

      const postVector = crdtProvider.getStateVector(noteId)
      if (!postVector || postVector.length <= 2) {
        await crdtProvider.seedFromMarkdownPublic(noteId)
        log.debug('applyCrdtIncrementals: seeded from markdown as fallback (no server CRDT)', {
          noteId
        })
      }
      return true
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('applyCrdtIncrementals aborted via signal', { noteId })
        return false
      }
      log.warn('Failed to apply CRDT incrementals', {
        noteId,
        error: err instanceof Error ? err.message : String(err)
      })
      this.owePendingPull(noteId)
      // Persistent note-body divergence (stale bodies across devices)
      // otherwise never reaches telemetry.
      if (!this.applyFailureReported.has(noteId)) {
        this.applyFailureReported.add(noteId)
        trackMainError('sync', 'crdt_apply_failed', err)
      }
      return false
    } finally {
      if (!wasOpen) {
        await crdtProvider.closeIfInactive(noteId)
      }
    }
  }

  async applyCrdtBatch(
    noteIds: string[],
    token: string,
    vaultKey: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    // The engine only holds an AbortController for the duration of a pull or a
    // push, so a caller outside one (the paced sweep) has to bring its own —
    // exactly as `pullCrdtForNote` does for the single-note path. Reading
    // `ctx.abortController` unconditionally here made every out-of-cycle batch
    // return without doing anything.
    const effectiveSignal = signal ?? this.ctx.abortController?.signal
    if (!crdtProvider || !effectiveSignal) return

    // A pass holds every one of its notes open from before the request is sent
    // until that note's updates are applied, so it must never open more than
    // the provider keeps cached: past the limit the LRU closes the notes it
    // opened first, applyRemoteUpdate drops their updates as "unopened doc",
    // and the seed check below then sees no state vector at all. The passes
    // that matter are exactly the oversized ones — a sign-in or a reconnect
    // sweep hands over the whole vault, several times the limit.
    //
    // Chunking here also keeps each request under the server's 100-note cap on
    // /sync/crdt/updates/batch, which a whole-vault pass otherwise blows past.
    const chunkSize = crdtProvider.inactiveDocCapacity
    for (let i = 0; i < noteIds.length; i += chunkSize) {
      if (effectiveSignal.aborted) return
      await this.applyCrdtBatchChunk(
        noteIds.slice(i, i + chunkSize),
        token,
        vaultKey,
        effectiveSignal
      )
    }
  }

  private async applyCrdtBatchChunk(
    noteIds: string[],
    token: string,
    vaultKey: Uint8Array,
    signal: AbortSignal
  ): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider) return

    const syncOpenedNoteIds = new Set<string>()
    // Per-pass record, so only a note this pass walked cleanly may have its
    // standing flag cleared at the end.
    const sawUnmerged = new Set<string>()
    // No `pendingPulls.delete` here, deliberately — the single-note path needs
    // one and this does not. Every caller of this path (the priority pull and
    // the paced sweep chunks) is handed notes that `drainPendingPulls()` has
    // already emptied out of the set, so a note that IS in it at this point was
    // put back by something running concurrently, and its payload is not in
    // this chunk. Keeping the flag standing is the right answer there.
    // `pullCrdtForNote` has no drain in front of it — the `crdt_updated`
    // broadcast and the pending-note replay call it directly — so a note's own
    // earlier debt would otherwise block its clear forever.
    try {
      const sinceMap = new Map<string, number>()

      for (const noteId of noteIds) {
        const wasOpen = crdtProvider.getDoc(noteId) != null
        try {
          await crdtProvider.open(noteId, undefined, { skipSeed: true })
          if (!wasOpen) syncOpenedNoteIds.add(noteId)
        } catch (err) {
          log.warn('Failed to open CRDT doc, skipping note in batch', {
            noteId,
            error: err instanceof Error ? err.message : String(err)
          })
          // Owed like every other failure in this pass. Without it this note is
          // never retried, so the unmerged flag it is carrying never clears and
          // it spends the rest of the session off the snapshot endpoint.
          this.owePendingPull(noteId)
          continue
        }

        try {
          const baseline = await this.applySnapshotBaseline(noteId, token, vaultKey, 'batch')
          sinceMap.set(noteId, baseline.since)
          if (!baseline.verified) {
            sawUnmerged.add(noteId)
            this.owePendingPull(noteId)
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err
          // A single note's baseline failure must not abandon every note left in
          // the pass. Skip it; the next pass retries it — which only holds
          // because it is re-queued here. This is the hottest failure path under
          // a rate limit: the baselines are one GET per note, so they are the
          // bulk of a sweep's requests and the first thing the server sheds.
          log.warn('Failed to apply CRDT snapshot baseline, skipping note in batch', {
            noteId,
            error: err instanceof Error ? err.message : String(err)
          })
          this.owePendingPull(noteId)
        }
      }

      if (sinceMap.size === 0) return

      const activeSince = new Map(sinceMap)

      while (activeSince.size > 0) {
        if (signal.aborted) {
          // Same reason as the open failure above: the notes still in flight
          // were never walked to the end, so they must stay owed and flagged.
          for (const noteId of activeSince.keys()) this.owePendingPull(noteId)
          return
        }

        const notes = Array.from(activeSince, ([noteId, since]) => ({ noteId, since }))

        const result = await withRetry(
          () =>
            postToServer<CrdtBatchPullResponse>(
              '/sync/crdt/updates/batch',
              { notes, limit: 100 },
              token
            ),
          {
            maxRetries: 3,
            baseDelayMs: 2000,
            signal,
            retryOn429: false
          }
        ).then((r) => r.value)

        const signerIds = new Set<string>()
        for (const noteData of Object.values(result.notes)) {
          for (const u of noteData.updates) signerIds.add(u.signerDeviceId)
        }
        await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))

        for (const [noteId, noteData] of Object.entries(result.notes)) {
          for (const entry of noteData.updates) {
            const bin = atob(entry.data)
            const packed = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i)

            const pubKey = await this.resolveDeviceKey(entry.signerDeviceId)
            if (!pubKey) {
              log.warn('Skipping CRDT batch update from unresolvable signer', {
                noteId,
                signerDeviceId: entry.signerDeviceId,
                sequenceNum: entry.sequenceNum
              })
              // Same reasoning as the single-note path: flag now so a throw
              // later in the chunk cannot leave a stale "safe to snapshot",
              // and owe the note a pull so a transient signer self-heals.
              sawUnmerged.add(noteId)
              this.owePendingPull(noteId)
              activeSince.set(noteId, entry.sequenceNum)
              continue
            }
            const decrypted = decryptCrdtUpdate(packed, vaultKey, noteId, pubKey)
            crdtProvider.applyRemoteUpdate(noteId, decrypted)
            activeSince.set(noteId, this.rememberAppliedSequence(noteId, entry.sequenceNum))
          }

          if (!noteData.hasMore) activeSince.delete(noteId)
        }

        for (const [noteId] of activeSince) {
          if (!result.notes[noteId]) {
            log.warn('Server omitted noteId from batch response, removing', { noteId })
            // Dropped without its updates ever arriving, so this pass did not
            // walk it to the end and may not clear its flag.
            sawUnmerged.add(noteId)
            activeSince.delete(noteId)
          }
        }
      }

      for (const noteId of sinceMap.keys()) {
        this.clearUnmergedIfClean(noteId, sawUnmerged.has(noteId))
      }

      // Seed only notes whose snapshot baseline succeeded. A note skipped at :205
      // was opened with { skipSeed: true } and stays open with an empty state
      // vector; seeding it here would persist local markdown, and the next pass's
      // real server snapshot would then merge as an independent insertion →
      // duplicated note body. Its baseline failed transiently; the next pass fetches it.
      for (const noteId of sinceMap.keys()) {
        const postVector = crdtProvider.getStateVector(noteId)
        // No vector at all means the doc is no longer open, which is not the
        // same as an open doc that turned out to be empty: the provider closed
        // it while this pass ran, so what the server holds is simply unknown
        // here. Seeding on that would write local markdown over a note whose
        // remote body was never applied. Leave it for the next pass.
        if (!postVector) {
          log.warn('Skipping markdown seed: CRDT doc closed mid-batch', { noteId })
          continue
        }
        if (postVector.length <= 2) {
          await crdtProvider.seedFromMarkdownPublic(noteId)
          log.debug('applyCrdtBatch: seeded from markdown as fallback (no server CRDT)', {
            noteId
          })
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('applyCrdtBatch aborted via signal')
        return
      }
      log.warn('Failed to apply CRDT batch', {
        error: err instanceof Error ? err.message : String(err)
      })
      // The chunk failed as a unit (a rate-limited or dead-lettered batch POST
      // takes every note in it), so every note in it is owed a retry.
      for (const noteId of noteIds) this.owePendingPull(noteId)
      // One undecryptable update aborts the remaining notes in the pass —
      // engine-level sync_run_completed still reports success without this.
      if (!this.applyFailureReported.has('__batch__')) {
        this.applyFailureReported.add('__batch__')
        trackMainError('sync', 'crdt_apply_failed', err)
      }
    } finally {
      for (const noteId of syncOpenedNoteIds) {
        await crdtProvider.closeIfInactive(noteId)
      }
    }
  }

  /** `false` = this note's server state was NOT fully merged; see `applyCrdtIncrementals`. */
  async pullCrdtForNote(noteId: string): Promise<boolean> {
    log.debug('pullCrdtForNote entered', { noteId })
    // Owed on both misses, exactly as the group sibling does. This is the entry
    // point a `crdt_updated` broadcast uses, so returning silently here left a
    // note the server had just named unpulled, unflagged and unretried.
    const token = await this.ctx.deps.getAccessToken()
    if (!token) {
      this.owePendingPull(noteId)
      return false
    }

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) {
      this.owePendingPull(noteId)
      return false
    }

    const localAbort = new AbortController()
    try {
      const merged = await this.applyCrdtIncrementals(noteId, token, vaultKey, localAbort.signal)
      log.debug('pullCrdtForNote completed', { noteId, merged })
      return merged
    } finally {
      secureCleanup(vaultKey)
    }
  }

  /**
   * Group sibling of `pullCrdtForNote`, and the entry point the vault-wide
   * sweep uses.
   *
   * The single-note path costs two HTTP GETs per note (snapshot baseline, then
   * incrementals), which is what turned a 121-note sweep into 242 requests in
   * about four seconds. This path shares one incrementals POST across the whole
   * group, so the same 121 notes cost roughly 125 requests — the snapshot
   * baselines are still one GET per note inside `applyCrdtBatch`, so this halves
   * the traffic rather than collapsing it to a handful of calls. Pacing, not
   * batching, is what actually keeps a sweep under the limit; see
   * CRDT_SWEEP_CHUNK_NOTES.
   *
   * Credentials are resolved once per group instead of once per note, which also
   * removes a keychain read per note. A group that cannot get them is owed a
   * retry rather than dropped: the sweep hands this method the whole vault, so
   * silently returning would strand every stale body until the next sweep.
   */
  async pullCrdtForNotes(noteIds: string[], signal?: AbortSignal): Promise<void> {
    if (noteIds.length === 0) return
    log.debug('pullCrdtForNotes entered', { count: noteIds.length })

    const token = await this.ctx.deps.getAccessToken()
    if (!token) {
      for (const noteId of noteIds) this.owePendingPull(noteId)
      return
    }

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) {
      for (const noteId of noteIds) this.owePendingPull(noteId)
      return
    }

    // A caller that can outlive this group passes its own signal: the paced
    // sweep spans minutes, so without one a group already in flight would keep
    // pulling after the engine was disposed, against a provider and vault it no
    // longer owns. Callers that cannot be torn down mid-group get a signal that
    // never fires, which is the behaviour the engine's own controller gave.
    const effectiveSignal = signal ?? new AbortController().signal
    try {
      await this.applyCrdtBatch(noteIds, token, vaultKey, effectiveSignal)
      log.debug('pullCrdtForNotes completed', { count: noteIds.length })
    } finally {
      secureCleanup(vaultKey)
    }
  }
}
