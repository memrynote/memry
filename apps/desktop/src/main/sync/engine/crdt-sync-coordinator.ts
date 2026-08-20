import { createLogger } from '../../lib/logger'
import { secureCleanup } from '../../crypto/index'
import { withRetry } from '../retry'
import {
  getFromServer,
  postToServer,
  fetchCrdtSnapshot,
  type CrdtBatchPullResponse,
  type CrdtSnapshotMeta
} from '../http-client'
import { decryptCrdtUpdate } from '../crdt-encrypt'
import { trackMainError } from '../../telemetry/diagnostics'
import type { CrdtPullCost, SyncContext } from './sync-context'
import type { CrdtProvider } from '../crdt-provider'

const log = createLogger('CrdtSyncCoordinator')

/**
 * The server's cap on the `notes` array of `POST /sync/crdt/updates/batch`
 * (`CrdtBatchPullSchema`, sync-server routes/sync.ts). A protocol fact, not a
 * pacing knob: it bounds the probe, which opens no document and so is not bound
 * by the doc cache, and it bounds an apply sub-chunk too, for the rare provider
 * configured to hold more docs open than the server will accept in one request.
 */
const CRDT_BATCH_MAX_NOTES = 100

const noCost = (): CrdtPullCost => ({ snapshotGets: 0, batchPosts: 0 })

export type ResolveDeviceKey = (deviceId: string) => Promise<Uint8Array | null>

export class CrdtSyncCoordinator {
  private ctx: SyncContext
  private pendingPulls = new Set<string>()
  private lastAppliedSequence = new Map<string, number>()
  /**
   * The `revision` of the server snapshot this session actually merged into the
   * note's doc — half of the watermark the sweep's conditional skip compares
   * against, `lastAppliedSequence` being the other half.
   *
   * Backed by the store, not by the session. Both halves are read out of, and
   * written back into, the per-vault CRDT store as a y-leveldb doc meta key —
   * see `crdt-snapshot-watermark.ts` for why that location is forced rather than
   * chosen. These two maps are a per-pass working copy of it, and they are
   * dropped the moment `crdtProvider.storeId` says the store underneath them
   * changed, so "the store is gone" still implies "the watermark is gone" for
   * the in-memory half too.
   *
   * Written only where a snapshot was genuinely decrypted and applied, never
   * where one was merely advertised: `getSnapshot` returns null when the D1 row
   * exists but its R2 blob is gone, and recording a watermark for a blob that
   * never arrived is exactly how a note keeps a stale body forever.
   */
  private mergedSnapshotRevision = new Map<string, string>()
  /**
   * The store the two maps above were filled from. A different value — a vault
   * switch, a quarantine-and-reopen, a re-path, a provider destroyed and rebuilt
   * — invalidates every watermark held in memory, because they describe
   * documents that store does not have.
   */
  private watermarkStoreId: string | null = null
  /**
   * Notes whose persisted watermark this session has already looked for, so a
   * note absent from the store is asked about once rather than once per chunk.
   * A miss is remembered as a miss; it must never become a zero.
   */
  private hydratedWatermarks = new Set<string>()
  /** Notes whose in-memory watermark has moved and has not reached the store yet. */
  private dirtyWatermarks = new Set<string>()
  /**
   * Set once a batch response comes back without `snapshotMeta`, which is how
   * an older server answers.
   *
   * Without it, every chunk against such a server would pay for a probe that
   * can never let anything be skipped — staging, self-hosted deployments and a
   * rolled-back server all live here. With it, the second chunk onwards issues
   * exactly the requests this code issued before this feature existed.
   */
  private snapshotMetaUnsupported = false
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
    // The in-memory copy only. The durable record lives in the CRDT store and is
    // deliberately left alone: a restart or a fresh sign-in re-reads it, which is
    // the entire point of persisting it, and this teardown is not evidence about
    // any document. Only the store going away is.
    this.dropWatermarks()
    this.watermarkStoreId = null
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
    if (!this.lastAppliedSequence.has(noteId) || next !== known) {
      this.dirtyWatermarks.add(noteId)
    }
    this.lastAppliedSequence.set(noteId, next)
    return next
  }

  /**
   * Throw away every watermark held in memory. Never touches the store: the
   * durable record is dropped by the store's own lifetime, not by this.
   */
  private dropWatermarks(): void {
    // Cleared together, never separately: the two maps are one watermark, and
    // half a watermark is a skip decision made on a guess.
    this.lastAppliedSequence.clear()
    this.mergedSnapshotRevision.clear()
    this.hydratedWatermarks.clear()
    this.dirtyWatermarks.clear()
  }

  /**
   * The store the watermarks may be read from and written to right now, after
   * reconciling anything held in memory with it.
   *
   * **This is the in-memory half of FM2 and it is not optional.** The durable
   * watermarks cannot outlive their store — they are keys inside it. The working
   * copy in `lastAppliedSequence` / `mergedSnapshotRevision` can: this process
   * keeps running across a vault switch, a store quarantined and reopened, and a
   * store re-pathed after device linking. Carrying watermarks across one of those
   * would skip a baseline against documents the new store never had. So every
   * read and every write goes through here first, and a changed `storeId` drops
   * the lot in the same operation.
   *
   * `null` means there is no store — no vault open yet, or the provider degraded
   * to in-memory mode because the store could not be trusted. Nothing is read
   * and nothing is written then, which is correct twice over: an in-memory
   * document is seeded from vault markdown rather than restored from CRDT
   * history, so there is no merge state a watermark could truthfully describe.
   */
  private watermarkStore(): CrdtProvider | null {
    const provider = this.ctx.deps.crdtProvider ?? null
    const storeId = provider?.storeId ?? null
    if (storeId !== this.watermarkStoreId) {
      this.dropWatermarks()
      this.watermarkStoreId = storeId
    }
    return storeId === null ? null : provider
  }

  /**
   * Fill the in-memory watermarks for a chunk from the store, so the first sweep
   * after a relaunch or a fresh sign-in is warm instead of cold.
   *
   * Runs before the probe, because the probe's `since` values and its
   * "has anything merged at all" test both read the maps this fills.
   *
   * A note the store has no record for is left absent, never zeroed: absent is
   * what `snapshotBaselineSkip` reads as unknown, and unknown fetches. A build
   * that predates the meta key wrote no records at all, so every note on such a
   * store lands there and the sweep costs exactly what it cost before.
   */
  private async hydrateWatermarks(noteIds: string[]): Promise<void> {
    const store = this.watermarkStore()
    if (!store) return

    for (const noteId of noteIds) {
      if (this.hydratedWatermarks.has(noteId)) continue
      // Marked before the await, so a concurrent chunk holding the same note
      // does not issue a second read for it.
      this.hydratedWatermarks.add(noteId)
      // Anything this session merged is newer than anything on disk, and it is
      // already in the maps.
      if (this.lastAppliedSequence.has(noteId)) continue

      const watermark = await store.getSnapshotWatermark(noteId)
      if (!watermark) continue
      // The store may have been swapped while the read was in flight, which
      // `dropWatermarks` would have cleared the hydration memo for. Writing this
      // record in now would put a watermark from the old store into the new
      // one's working copy.
      if (store.storeId !== this.watermarkStoreId) return

      this.lastAppliedSequence.set(noteId, watermark.appliedSequence)
      if (watermark.snapshotRevision) {
        this.mergedSnapshotRevision.set(noteId, watermark.snapshotRevision)
      } else {
        this.mergedSnapshotRevision.delete(noteId)
      }
    }
  }

  /**
   * Write back the watermarks this pass moved.
   *
   * Deferred to the end of the pass rather than written per update: a pass that
   * throws half way through then persists nothing for the notes it did not
   * finish, and losing a watermark is the free direction. Ordering against the
   * document bytes is safe by construction — `applyRemoteUpdate` hands each
   * update to the store before this runs, and y-leveldb serialises its
   * transactions — so the document is durable before the watermark that
   * describes it.
   */
  private async flushWatermarks(): Promise<void> {
    if (this.dirtyWatermarks.size === 0) return
    const store = this.watermarkStore()
    if (!store) {
      // No store to write to. `watermarkStore()` has already dropped the
      // in-memory copy if the store changed under this pass, which also empties
      // the dirty set.
      this.dirtyWatermarks.clear()
      return
    }

    const pending = Array.from(this.dirtyWatermarks)
    this.dirtyWatermarks.clear()
    for (const noteId of pending) {
      const appliedSequence = this.lastAppliedSequence.get(noteId)
      if (appliedSequence === undefined) continue
      await store.putSnapshotWatermark(noteId, {
        appliedSequence,
        snapshotRevision: this.mergedSnapshotRevision.get(noteId)
      })
    }
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
    mode: 'single' | 'batch',
    cost: CrdtPullCost
  ): Promise<{ since: number; verified: boolean }> {
    // Charged before the request, not after: a GET that throws still spent the
    // bucket, and a failure is exactly when the next chunk most needs to wait.
    cost.snapshotGets++
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
    // Recorded here and nowhere else, after the bytes are in the doc: every
    // early return above left the baseline out, and a watermark for a baseline
    // that was never applied is a skip of the download that would have fixed it.
    //
    // An absent token — an older server on this endpoint — DELETES any token
    // held for the note rather than leaving one standing. The blob just merged
    // is not the one the old token names, so keeping it would compare a future
    // batch response against a baseline this doc no longer has.
    if (snapshotResult.revision) {
      this.mergedSnapshotRevision.set(noteId, snapshotResult.revision)
    } else {
      this.mergedSnapshotRevision.delete(noteId)
    }
    // Queued for the store from this one place too, for the same reason: only a
    // baseline that reached the document may leave a durable record of itself.
    this.dirtyWatermarks.add(noteId)
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
   *
   * **A local-only note is not pulled at all.** #1511 closed the push half of
   * "this note never leaves the device"; this is the other half, and the setting
   * means nothing else: a note that can never push has no business taking the
   * server's state either, and pulling it spends `crdt_pull` budget the notes
   * that *can* sync are competing for. The answer is `false` — the contract is
   * "the server's state is in this doc", and here it deliberately is not — but
   * NOT an owed pull: a debt nothing will ever settle would re-queue the note in
   * every sweep forever. Its `unmergedRemoteNotes` flag is left standing on
   * purpose; it costs nothing while the note cannot push, and if the toggle is
   * ever turned off it is the conservative answer for that note's first push.
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

    if (crdtProvider.isNoteLocalOnly(noteId)) {
      log.debug('Skipping CRDT pull for a local-only note', { noteId })
      return false
    }

    // Reconcile with the store BEFORE this pass records anything, not only in
    // the flush at the end: the first reconcile of a session drops whatever the
    // maps held, and doing it after the pass would drop the very watermark this
    // pass just moved. Deliberately not a hydrate — this path never reads a
    // watermark (FM4), it only moves one.
    this.watermarkStore()

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

      // The single-note path is not paced, so nothing reads this back. It is
      // still counted rather than made optional, so there is one shape for
      // "what a baseline costs" instead of two.
      const baseline = await this.applySnapshotBaseline(noteId, token, vaultKey, 'single', noCost())
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
      // The single-note path never *consults* a watermark — that is FM4, and it
      // stays unconditional — but it does move one, and a move it did not record
      // is a cold baseline the next sweep pays for.
      await this.flushWatermarks()
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
  ): Promise<CrdtPullCost> {
    const cost = noCost()
    const crdtProvider = this.ctx.deps.crdtProvider
    // The engine only holds an AbortController for the duration of a pull or a
    // push, so a caller outside one (the paced sweep) has to bring its own —
    // exactly as `pullCrdtForNote` does for the single-note path. Reading
    // `ctx.abortController` unconditionally here made every out-of-cycle batch
    // return without doing anything.
    const effectiveSignal = signal ?? this.ctx.abortController?.signal
    if (!crdtProvider || !effectiveSignal) return cost

    // Same guard as the single-note path — see `applyCrdtIncrementals` — and
    // applied before the chunking below rather than inside it, so a vault with
    // many local-only notes still fills each chunk with notes that can sync
    // instead of spending whole paced chunks on ones that are all skipped.
    const syncable = noteIds.filter((noteId) => !crdtProvider.isNoteLocalOnly(noteId))
    if (syncable.length !== noteIds.length) {
      log.debug('Skipping local-only notes in a CRDT batch pull', {
        skipped: noteIds.length - syncable.length
      })
    }
    if (syncable.length === 0) return cost

    // Chunked at the PROBE's ceiling, which is the server's 100-note cap on
    // /sync/crdt/updates/batch and nothing else. The probe opens no document,
    // so the doc cache does not bound it — the apply phase inside each chunk
    // sub-chunks itself at `inactiveDocCapacity`, which is where that bound
    // belongs. Sizing this loop at the doc cache instead would spend one probe
    // POST per 32 notes rather than per 100, and the probe POST is the whole
    // cost of a warm sweep.
    for (let i = 0; i < syncable.length; i += CRDT_BATCH_MAX_NOTES) {
      if (effectiveSignal.aborted) return cost
      await this.applyCrdtBatchChunk(
        syncable.slice(i, i + CRDT_BATCH_MAX_NOTES),
        token,
        vaultKey,
        effectiveSignal,
        cost
      )
    }
    return cost
  }

  /**
   * One `POST /sync/crdt/updates/batch` that asks the server what moved, before
   * a single doc is opened or a single snapshot downloaded.
   *
   * `null` means "decide nothing from a probe" and every note in the chunk then
   * takes the unconditional path this method fronts — an old server, or a chunk
   * where a probe could not possibly save anything.
   *
   * Deliberately NOT available to `applyCrdtIncrementals`: see the comment on
   * `snapshotBaselineSkip`.
   */
  private async probeBatchChunk(
    noteIds: string[],
    token: string,
    signal: AbortSignal,
    cost: CrdtPullCost
  ): Promise<CrdtBatchPullResponse | null> {
    if (this.snapshotMetaUnsupported) return null
    // No watermark for any note in the chunk means nothing can match, so every
    // note would fall through to a fetch anyway and the probe would be a request
    // spent to learn nothing. Reached on a genuinely cold vault — a first sync,
    // or a store rebuilt or quarantined under this one — and it costs exactly
    // what it cost before this feature existed. `hydrateWatermarks` has already
    // run, so a relaunch over an existing store is NOT cold here.
    if (!noteIds.some((noteId) => this.lastAppliedSequence.has(noteId))) return null

    const result = await withRetry(
      () => {
        // Inside the retry callback, so an attempt the server 5xx'd is charged
        // like any other: the bucket counts attempts, not successes.
        cost.batchPosts++
        return postToServer<CrdtBatchPullResponse>(
          '/sync/crdt/updates/batch',
          {
            notes: noteIds.map((noteId) => ({
              noteId,
              since: this.lastAppliedSequence.get(noteId) ?? 0
            })),
            // This asks "did anything change", not "give me what changed": a
            // note whose answer is yes goes to the apply phase, which fetches
            // its updates from the right `since` — after a baseline, when it
            // needs one. Asking for 100 here would haul payloads that phase
            // re-fetches. `hasMore` is still exact at this limit, because the
            // server reads limit + 1 rows to compute it.
            limit: 1
          },
          token
        )
      },
      { maxRetries: 3, baseDelayMs: 2000, signal, retryOn429: false }
    ).then((r) => r.value)

    // An absent key, not an empty map: this response is read through a cast
    // with no runtime validation, so this is the only signal that the server
    // predates the token. Latched, so the rest of the session stops paying for
    // a probe whose answer can never be "skip".
    if (!result.snapshotMeta) {
      this.snapshotMetaUnsupported = true
      log.debug('Server returned no snapshotMeta; CRDT snapshot baselines stay unconditional')
      return null
    }

    return result
  }

  /**
   * The `since` to resume from without downloading this note's snapshot, or
   * `null` to download it.
   *
   * **This is only ever consulted from `applyCrdtBatchChunk`, and that is a
   * data-loss guard rather than an accident of layering.**
   * `applyCrdtIncrementals` returns whether the server's state was fully merged,
   * and the pending-note replay acts on a `true` by pushing a *snapshot* — which
   * asserts "I contain everything you hold" and makes the server delete every
   * device's incrementals at or below the watermark. A `true` reached by a
   * shortcut therefore destroys a peer's edits. The single-note path is low
   * volume in every one of its callers, so it gives up nothing by staying
   * unconditional, and staying unconditional is what makes the guarantee
   * structural instead of careful.
   *
   * Every unknown answers `null`. A missed skip costs one GET; a wrong skip
   * costs a note body.
   */
  private snapshotBaselineSkip(
    noteId: string,
    snapshotMeta: Record<string, CrdtSnapshotMeta> | undefined
  ): number | null {
    // No probe, or a server that does not publish the token. Fetch, exactly as
    // this code did before the token existed.
    if (!snapshotMeta) return null

    // A note with no watermark — never merged, absent from the local store, a
    // store rebuilt or quarantined under it, or a store written by a build that
    // predates the persisted watermark — cannot be shown to already hold the
    // baseline. Unknown fetches; it never reads as sequence 0.
    const appliedSequence = this.lastAppliedSequence.get(noteId)
    if (appliedSequence === undefined) return null

    const meta = snapshotMeta[noteId]
    // Map present, note absent: the server holds no snapshot for this note at
    // all. Nothing to download, and nothing has been pruned, so resuming from
    // the watermark asks a range the server still has.
    if (!meta) return appliedSequence

    // (1) The server's snapshot blob is the one already merged into this doc.
    // `sequence_num` cannot stand in for this: `storeSnapshot` pins it across a
    // rewrite, so it would report "unchanged" for every replaced blob.
    if (meta.revision !== this.mergedSnapshotRevision.get(noteId)) return null

    // (2) And the doc has taken in everything at or below the server's prune
    // watermark. `pruneUpdatesBeforeSnapshot` deletes every update at or below
    // `sequence_num`, so a `since` under it is answered with silence rather
    // than an error — the note would go quietly stale. This is a separate
    // question from (1) and must be asked separately: a matching revision says
    // which blob the server holds, never how much of it this doc absorbed.
    if (appliedSequence < meta.sequenceNum) return null

    return appliedSequence
  }

  /**
   * One probe-sized chunk: at most `CRDT_BATCH_MAX_NOTES` notes, one probe POST
   * for all of them, then the apply phase over whatever the probe could not
   * settle — sub-chunked at the doc cache, because that phase holds its notes
   * open across an await and the probe does not.
   */
  private async applyCrdtBatchChunk(
    noteIds: string[],
    token: string,
    vaultKey: Uint8Array,
    signal: AbortSignal,
    cost: CrdtPullCost
  ): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider) return

    try {
      // PHASE 0 — hydrate. Read this chunk's watermarks out of the CRDT store,
      // so the first sweep after a relaunch or a fresh sign-in can skip the
      // baselines whose bodies are already sitting in that same store. No
      // network, no docs opened; a note the store has no record for stays
      // unknown and therefore takes the full path.
      await this.hydrateWatermarks(noteIds)

      // PHASE 1 — probe. One request for the whole chunk, no docs opened.
      //
      // Every note in the chunk is still visited: this decides what a note
      // costs, never whether it is looked at. The sweep is the only channel a
      // body-only remote edit reaches a device by — note bodies never travel in
      // the record change feed — so a note dropped here would go stale with no
      // second chance.
      const probe = await this.probeBatchChunk(noteIds, token, signal, cost)

      // Notes whose baseline the probe proved redundant, mapped to the `since`
      // to resume from in place of the one a baseline would have produced.
      const skipBaseline = new Map<string, number>()
      // Notes still needing the open + baseline + apply path below.
      const activeNoteIds: string[] = []
      let settledByProbe = 0

      for (const noteId of noteIds) {
        const skipSince = this.snapshotBaselineSkip(noteId, probe?.snapshotMeta)
        const probed = probe?.notes[noteId]
        // A note the server left out of its own probe response told us nothing
        // about its updates, so it takes the full path regardless.
        if (skipSince !== null && probed) {
          if (probed.updates.length === 0 && !probed.hasMore) {
            // Finished here: the baseline is already in the doc and there is
            // nothing above it. No doc opened, no snapshot GET, no decrypt.
            // Clearing the flag is the truth this pass established — the
            // server's state for this note IS in the local doc.
            //
            // Not seed-checked at the end, and it does not need to be: a note
            // only reaches this branch with a watermark, which only exists
            // because real CRDT state was applied to its doc, so its state
            // vector is not the empty one the seed fallback exists for.
            this.clearUnmergedIfClean(noteId, false)
            settledByProbe++
            continue
          }
          skipBaseline.set(noteId, skipSince)
        }
        activeNoteIds.push(noteId)
      }

      if (probe) {
        log.debug('CRDT batch chunk probed', {
          notes: noteIds.length,
          settledByProbe,
          baselinesSkipped: skipBaseline.size,
          baselinesFetched: activeNoteIds.length - skipBaseline.size
        })
      }

      if (activeNoteIds.length === 0) return

      // PHASE 2 — apply, in sub-chunks the provider can actually hold open.
      //
      // This is the LRU bound, and it is a hard one: a sub-chunk holds every
      // one of its notes open from before the request is sent until that note's
      // updates are applied, so past `inactiveDocCapacity` the cache closes the
      // notes it opened first, `applyRemoteUpdate` drops their updates as
      // "unopened doc", and the seed check then sees no state vector at all.
      // Capped at the server's batch limit too, for a provider configured to
      // hold more docs open than one request may name.
      const applySize = Math.max(
        1,
        Math.min(crdtProvider.inactiveDocCapacity, CRDT_BATCH_MAX_NOTES)
      )
      for (let i = 0; i < activeNoteIds.length; i += applySize) {
        if (signal.aborted) {
          // The sub-chunks not reached were never walked, so they stay owed.
          for (const noteId of activeNoteIds.slice(i)) this.owePendingPull(noteId)
          return
        }
        await this.applyProbedNotes(
          activeNoteIds.slice(i, i + applySize),
          skipBaseline,
          token,
          vaultKey,
          signal,
          cost
        )
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
      // takes every note in it), so every note in it is owed a retry. A
      // sub-chunk that already finished is re-queued too: re-applying a CRDT
      // update is a no-op, its watermark is already flushed, and the next pass
      // settles it from the probe for one request instead of dropping it.
      for (const noteId of noteIds) this.owePendingPull(noteId)
      // One undecryptable update aborts the remaining notes in the pass —
      // engine-level sync_run_completed still reports success without this.
      if (!this.applyFailureReported.has('__batch__')) {
        this.applyFailureReported.add('__batch__')
        trackMainError('sync', 'crdt_apply_failed', err)
      }
    }
  }

  /**
   * The apply phase over one doc-cache-sized group: open, baseline where the
   * probe could not rule it out, then loop the batch endpoint for incrementals.
   *
   * Its notes are opened and closed inside this call, so a chunk larger than the
   * doc cache still never holds more than `inactiveDocCapacity` docs at once.
   */
  private async applyProbedNotes(
    noteIds: string[],
    skipBaseline: Map<string, number>,
    token: string,
    vaultKey: Uint8Array,
    signal: AbortSignal,
    cost: CrdtPullCost
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

        const skipSince = skipBaseline.get(noteId)
        if (skipSince !== undefined) {
          // The GET this whole change exists to avoid. The doc already holds
          // this exact snapshot blob and everything the server pruned behind
          // it, so resuming from the watermark is the same `since` a download
          // would have produced.
          sinceMap.set(noteId, skipSince)
          continue
        }

        try {
          const baseline = await this.applySnapshotBaseline(noteId, token, vaultKey, 'batch', cost)
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
          // bulk of a cold sweep's requests and the first thing the server sheds.
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
          () => {
            // Every round of this loop is another POST on `crdt_batch_pull` —
            // the "one POST per chunk" figure is a floor, so it is counted
            // here rather than assumed by the pacer.
            cost.batchPosts++
            return postToServer<CrdtBatchPullResponse>(
              '/sync/crdt/updates/batch',
              { notes, limit: 100 },
              token
            )
          },
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

      // Seed only notes whose snapshot baseline succeeded. A note whose baseline
      // threw was opened with { skipSeed: true } and stays open with an empty
      // state vector; seeding it here would persist local markdown, and the next
      // pass's real server snapshot would then merge as an independent insertion
      // → duplicated note body. Its baseline failed transiently; the next pass
      // fetches it.
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
    } finally {
      // Before the docs are closed, so the store is still the one these
      // watermarks describe — and per sub-chunk rather than per chunk, so a
      // later sub-chunk failing cannot lose what an earlier one merged.
      await this.flushWatermarks()
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
   * baselines are still one GET per note inside `applyCrdtBatch` whenever a
   * baseline is actually needed, so on a cold group this halves the traffic
   * rather than collapsing it to a handful of calls. A warm group costs one
   * probe POST and nothing else. Pacing, not batching, is what actually keeps a
   * sweep under the limit; see CRDT_SWEEP_CHUNK_NOTES.
   *
   * Credentials are resolved once per group instead of once per note, which also
   * removes a keychain read per note. A group that cannot get them is owed a
   * retry rather than dropped: the sweep hands this method the whole vault, so
   * silently returning would strand every stale body until the next sweep.
   */
  async pullCrdtForNotes(noteIds: string[], signal?: AbortSignal): Promise<CrdtPullCost> {
    if (noteIds.length === 0) return noCost()
    log.debug('pullCrdtForNotes entered', { count: noteIds.length })

    const token = await this.ctx.deps.getAccessToken()
    if (!token) {
      for (const noteId of noteIds) this.owePendingPull(noteId)
      return noCost()
    }

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) {
      for (const noteId of noteIds) this.owePendingPull(noteId)
      return noCost()
    }

    // A caller that can outlive this group passes its own signal: the paced
    // sweep spans minutes, so without one a group already in flight would keep
    // pulling after the engine was disposed, against a provider and vault it no
    // longer owns. Callers that cannot be torn down mid-group get a signal that
    // never fires, which is the behaviour the engine's own controller gave.
    const effectiveSignal = signal ?? new AbortController().signal
    try {
      const cost = await this.applyCrdtBatch(noteIds, token, vaultKey, effectiveSignal)
      log.debug('pullCrdtForNotes completed', { count: noteIds.length, ...cost })
      // What this group actually spent, per bucket. The paced sweep charges its
      // next interval against it — see `crdtSweepChunkDelayMs`. Every other
      // caller (the un-paced priority batch) discards it.
      return cost
    } finally {
      secureCleanup(vaultKey)
    }
  }
}
