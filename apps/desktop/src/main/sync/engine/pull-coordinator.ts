import { createLogger } from '../../lib/logger'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import type { RecordChangesResponse } from '@memry/contracts/sync-api'
import { secureCleanup } from '../../crypto/index'
import { decryptPullBatch } from '../sync-crypto-batch'
import { beginPageApply, replayBulkApplyJournal } from '../bulk-apply'
import { drainPendingSyncIntents } from '../sync-intents'
import { MissingSyncParentError } from '@memry/sync-client/item-handlers/types'
import { withRetry } from '@memry/sync-client/retry'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { engineAuthRetryDeps, withAuthRetry } from '../auth-retry'
import { getFromServer, NOTE_BODY_FEED_HEADERS, RateLimitError } from '../http-client'
import { classifyError } from '../sync-errors'
import { syncErrorTelemetry } from '../sync-error-telemetry'
import { SyncTimer } from '@memry/sync-client/sync-timer'
import { recordBootstrapBytes } from '../bootstrap-metrics'
import { trackMainEvent } from '../../telemetry/track'
import type { SyncContext } from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { QuarantineManager } from './quarantine-manager'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import { CorruptItemTracker, type ItemRef, type RecoveredItem } from './corrupt-item-tracker'
import { SchemaInvalidLedger } from './schema-invalid-ledger'
import { sortByApplyOrder } from './apply-order'
import { applyDecryptedItem } from './apply-decrypted'
import {
  refetchCorruptItems,
  retrySchemaInvalidItems,
  routeDeferredRetryFailure,
  type ItemRecoveryDeps
} from './item-recovery'
import { carriesCrdtBody, parsePullItems, purgedTombstoneApplyItems } from './pull-envelope'
import { fetchSliceBody, planPullSlices, type PullSlice } from './changes-page'
import { NoteBodyFeed } from './note-body-feed'
import { repairOrphans, type OrphanRef } from './orphan-repair'
import { reportConflict } from './conflict-report'
import { listedCursorOf, RunAppliedCursors } from './run-applied-cursors'
import type { PullRunState } from './pull-run-state'
import { tripPullBreaker } from './pull-breaker'
import { PullLatencyTrace } from './sync-latency-telemetry'
import {
  SYNC_STATE_KEYS,
  YIELD_EVERY_N_ITEMS,
  yieldToEventLoop,
  BOOTSTRAP_CRDT_INACTIVE_DOC_LIMIT
} from './sync-context'

const log = createLogger('PullCoordinator')

type DecryptedPullItem = Awaited<ReturnType<typeof decryptPullBatch>>['decrypted'][number]

// Why a page stopped the pull run:
// - 'transition': key material is mid-swap (sign-in/recovery) — momentary, do
//   not advance the cursor, the flow re-pulls cleanly once the key settles.
// - 'mismatch': the local key does not match the account — do not advance,
//   recovery must run first.
// - 'breaker': the key is right but the page's payloads are undecryptable
//   (server-side poisoned data) — advance past the page, mark items corrupt.
// - 'invalid_response': /sync/pull answered with no pull envelope, a server
//   contract regression — do not advance, the page re-pulls once it is fixed
//   (#2285).
type PageStopReason = 'none' | 'transition' | 'mismatch' | 'breaker' | 'invalid_response'
/**
 * Stops that hold the cursor: the page re-arrives on the next pull. Advancing
 * on one of these made the next manual Retry resume past the failing page and
 * report a clean sync while its items were never applied.
 */
const HOLDS_CURSOR = new Set<PageStopReason>(['transition', 'mismatch', 'invalid_response'])

export class PullCoordinator {
  private ctx: SyncContext
  private stateManager: SyncStateManager
  private quarantine: QuarantineManager
  private crdtSync: CrdtSyncCoordinator
  private pushCoordinator: PushCoordinator
  private corruptTracker: CorruptItemTracker
  readonly schemaInvalid: SchemaInvalidLedger
  private noteBodyFeed: NoteBodyFeed
  private deviceKeyCache = new Map<string, Uint8Array | null>()
  /** Items whose apply threw (e.g. FK parent not pulled yet) — retried once after all pages land */
  private pendingApplyRetries: DecryptedPullItem[] = []
  /** Items still missing an FK parent after the deferred retry — repaired at end of run (#837) */
  private orphanedItems: OrphanRef[] = []
  /** Wired by the engine: the change feed reset the legacy note-body sweep (#2297). */
  onNoteBodyLegacySweepReset: () => void = () => {}
  private ownedThroughCursor = 0

  /**
   * The highest `nextCursor` of a changes page a pull has read, until
   * LAST_CURSOR reaches it. Every row at or below it belongs to the pull: it
   * applies it, defers it, or leaves LAST_CURSOR unwritten so the page is
   * pulled again. Its rows can commit before LAST_CURSOR moves (a slice before
   * the last, a page with post-commit work, a run that stops mid-page), so a
   * socket frame at or below it may be older than a row already applied and is
   * left alone (#2300). Too high only sends frames to the pull.
   */
  get ownedThrough(): number {
    const lastCursor = Number(this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? 0)
    if (this.ownedThroughCursor <= lastCursor) this.ownedThroughCursor = 0
    return this.ownedThroughCursor
  }

  constructor(
    ctx: SyncContext,
    stateManager: SyncStateManager,
    quarantine: QuarantineManager,
    crdtSync: CrdtSyncCoordinator,
    pushCoordinator: PushCoordinator
  ) {
    this.ctx = ctx
    this.stateManager = stateManager
    this.quarantine = quarantine
    this.crdtSync = crdtSync
    this.pushCoordinator = pushCoordinator
    this.corruptTracker = new CorruptItemTracker(ctx, quarantine, (id) => this.resolveDeviceKey(id))
    this.schemaInvalid = new SchemaInvalidLedger(stateManager)
    this.noteBodyFeed = new NoteBodyFeed({
      ctx,
      stateManager,
      ledger: this.schemaInvalid,
      crdtSync: () => this.crdtSync,
      resolveDeviceKey: (id) => this.resolveDeviceKey(id),
      onLegacySweepReset: () => this.onNoteBodyLegacySweepReset()
    })
  }

  /**
   * Resolves TRUE only when the run finished clean enough for
   * `finalizePullSuccess` to record it. A busy lock, missing credentials, a
   * page the run refused to apply and an error this coordinator swallowed all
   * resolve FALSE (#1835).
   *
   * Nothing that used to be swallowed is rethrown here and nothing that used to
   * be rethrown is swallowed — the outcome is only *reported* alongside the
   * existing behaviour, because every error path out of a pull is silent and a
   * caller that needs to know whether anything was actually delivered cannot
   * infer it from the promise not rejecting.
   */
  async pull(): Promise<boolean> {
    const release = await this.ctx.acquireLock()
    if (!release) return false

    const cleanup = this.createPullCleanup(release)
    let vaultKey: Uint8Array | null = null
    let delivered = false
    this.deviceKeyCache.clear()

    try {
      const pullStartedAt = Date.now()
      this.stateManager.setState('syncing')
      this.ctx.abortController = new AbortController()

      const credentials = await this.getPullCredentials()
      if (!credentials) return false
      vaultKey = credentials.vaultKey

      const runState = this.createPullRunState(
        credentials.accessJwt,
        credentials.vaultKey,
        pullStartedAt
      )
      this.pendingApplyRetries = []
      this.orphanedItems = []
      try {
        // Heal note files a previous run journaled but never flushed (crash
        // between a page's DB commit and its file writes) before any new page
        // can apply on top of them.
        replayBulkApplyJournal()
        // Before any page: a local edit whose intent failed earlier gets its
        // clock now, so remote rows compare against it (#2301).
        drainPendingSyncIntents(this.ctx.deps.db, 'pull')
        await retrySchemaInvalidItems(
          this.recoveryDeps((item, op) => {
            this.stateManager.emitItemSynced(item.id, item.type, 'pull', op)
            this.queueBodyPull(runState, item, op)
          }),
          credentials.accessJwt,
          vaultKey
        )
        await this.pullChanges(runState)
        await this.applyDeferredRetries(runState)
        await this.repairOrphanedItems(runState)
        // Records these applied off their page pull their whole bodies here: a
        // rowless feed body on that page was dropped in reliance on it (#2297).
        await this.applyCrdtBatch(runState)
        if (runState.refused) {
          // The run stopped on a page it could not apply. Recording a success
          // history row and a fresh lastSyncAt here is what made a failing
          // Retry look like a clean sync in the 2026-07-18 incident.
          log.warn('Pull finished on a refused page — not recording a successful sync', {
            pulledCount: runState.pulledCount
          })
        } else {
          this.finalizePullSuccess(runState)
          delivered = true
        }
      } catch (error) {
        this.handlePullError(error, runState.startTime)
      }
    } finally {
      this.cleanupAfterPull(vaultKey, cleanup)
    }
    return delivered
  }

  periodicPull(): void {
    if (
      this.ctx.syncing ||
      this.ctx.fullSyncActive ||
      this.stateManager.isPaused() ||
      !this.ctx.deps.network.online
    ) {
      log.debug('Periodic pull skipped', {
        syncing: this.ctx.syncing,
        fullSyncActive: this.ctx.fullSyncActive,
        paused: this.stateManager.isPaused(),
        online: this.ctx.deps.network.online
      })
      return
    }
    this.ctx.scheduleSync(async () => {
      await this.pull()
    })
  }

  async resolveDeviceKey(deviceId: string): Promise<Uint8Array | null> {
    if (this.deviceKeyCache.has(deviceId)) {
      return this.deviceKeyCache.get(deviceId)!
    }
    const key = await this.ctx.deps.getDevicePublicKey(deviceId)
    this.deviceKeyCache.set(deviceId, key)
    return key
  }

  private recoveryDeps(onChanged: ItemRecoveryDeps['onChanged']): ItemRecoveryDeps {
    return {
      ctx: this.ctx,
      tracker: this.corruptTracker,
      ledger: this.schemaInvalid,
      onChanged,
      pullNoteBody: (noteId, token, key) => this.noteBodyFeed.heal(noteId, token, key)
    }
  }

  clearCaches(): void {
    this.deviceKeyCache.clear()
    this.corruptTracker.clear()
  }

  private createPullCleanup(release: () => void): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.ctx.releaseLock()
      release()
    }
  }

  private async getPullCredentials(): Promise<{ accessJwt: string; vaultKey: Uint8Array } | null> {
    const accessJwt = await this.ctx.deps.getAccessToken()
    if (!accessJwt) return null

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) return null

    return { accessJwt, vaultKey }
  }

  private createPullRunState(
    accessJwt: string,
    vaultKey: Uint8Array,
    startTime: number
  ): PullRunState {
    return {
      timer: new SyncTimer(),
      startTime,
      pulledCount: 0,
      totalConflictsResolved: 0,
      applied: new RunAppliedCursors(),
      crdtNoteIds: [],
      accessJwt,
      vaultKey,
      latency: new PullLatencyTrace(getCurrentDeviceId(this.ctx.deps.db))
    }
  }

  // Oldest-first on purpose, even though progressive open (#1830) would rather
  // show recent notes first: /sync/changes is a strictly ascending
  // `server_cursor > ?` feed and each page's persisted cursor is the
  // crash-resume watermark. Newest-first would need a descending server feed
  // with a two-ended resume contract (that is P2.2 pack ordering) or buffering
  // every page before applying — which kills the page-by-page fill and makes
  // an interrupted first sync silently skip older pages the advanced cursor
  // now claims were applied.
  private async pullChanges(runState: PullRunState): Promise<void> {
    let cursor = this.stateManager.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)
    let hasMore = true
    runState.fromZero = !cursor || cursor === '0'

    type ChangesRetryResult = Awaited<ReturnType<typeof this.fetchChangesPage>>
    let changesResult: ChangesRetryResult
    let prefetchedNext: Promise<ChangesRetryResult> | null = null

    while (hasMore) {
      // Same refusal as the post-apply check below, one iteration earlier: a
      // cancel that lands before the first page is even fetched (vault
      // close/switch calls `engine.requestCancel()` routinely) delivered
      // nothing, so the run must not be recorded as a clean sync either.
      if (this.ctx.abortController!.signal.aborted) {
        runState.refused = true
        break
      }

      if (prefetchedNext) {
        changesResult = await prefetchedNext
        prefetchedNext = null
      } else {
        // Only a run's first page is fetched here, and only it asks for inline
        // payloads: backlog and bootstrap keep 500-ref pages (#2292).
        changesResult = await this.fetchChangesPage(runState, cursor, !this.ctx.fullSyncActive)
      }

      const changes = changesResult.value
      const nextCursor = String(changes.nextCursor)
      this.ownedThroughCursor = Math.max(this.ownedThroughCursor, changes.nextCursor)

      // Fetch page N+1 WHILE page N is applied, not after: starting the
      // prefetch below the apply meant it was awaited on the very next
      // iteration and overlapped nothing. /sync/changes is a read, so fetching
      // ahead of the stop decision costs at most one wasted GET on a run that
      // stops — the abandoned promise's rejection is swallowed either way.
      if (changes.hasMore && !this.ctx.abortController?.signal.aborted) {
        prefetchedNext = this.fetchChangesPage(runState, nextCursor)
        prefetchedNext.catch(() => {})
      }

      const { stop, cursorCommitted } = await this.pullChangesPage(changes, runState, nextCursor)
      this.emitInitialSyncProgress(changes, runState.pulledCount)

      if (HOLDS_CURSOR.has(stop)) {
        runState.refused = true
        break
      }

      // An abort can land INSIDE the page's item loop (vault close/switch now
      // calls engine.requestCancel() routinely): processPage breaks out with
      // part of the slice applied, commits that partial page and still reports
      // 'none'. Advancing the watermark past the whole page would strand the
      // items it never reached — the feed is `server_cursor > ?`, so it never
      // offers them again. Re-check before the cursor moves (the in-slice write
      // makes the same check), and refuse the run so an interrupted pull is not
      // recorded as a clean sync.
      if (this.ctx.abortController!.signal.aborted) {
        runState.refused = true
        break
      }

      // A page whose last slice had post-commit work to finish did not commit
      // the cursor with its rows; it moves here, after that work, as it did
      // before #2294. A crash in between re-pulls the page, and the rows that
      // already committed come back identical and skip.
      if (!cursorCommitted) this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, nextCursor)
      cursor = nextCursor
      hasMore = changes.hasMore

      // Circuit breaker (key matches the account but the page's payloads are
      // undecryptable — server-side poisoned data): the cursor DOES advance,
      // because these items can never decrypt no matter how often they are
      // re-pulled, and pinning the cursor here would block every later item
      // from ever reaching this device. The failures were marked corrupt and
      // surfaced; the run still ends in an error state, not a fake success.
      if (stop === 'breaker') {
        runState.refused = true
        break
      }
    }
  }

  private async fetchChangesPage(
    runState: PullRunState,
    pageCursor: string | null | undefined,
    inline = false
  ): ReturnType<typeof withRetry<RecordChangesResponse>> {
    return withRetry(
      () => {
        const cp = (pageCursor ? `&cursor=${pageCursor}` : '') + (inline ? '&inline=1' : '')
        return withAuthRetry(
          (authToken) =>
            runState.latency.timeChanges(() =>
              getFromServer<RecordChangesResponse>(
                `/sync/changes?limit=${this.ctx.options.pullPageLimit}${cp}`,
                authToken,
                undefined,
                // A run from cursor 0 keeps 500-row record pages; its record
                // pages and the legacy sweep deliver the bodies (#2297).
                { headers: runState.fromZero ? undefined : NOTE_BODY_FEED_HEADERS }
              )
            ),
          runState.accessJwt,
          engineAuthRetryDeps(this.ctx.deps),
          (fresh) => {
            runState.accessJwt = fresh
          }
        )
      },
      {
        signal: this.ctx.abortController!.signal,
        isOnline: () => this.ctx.deps.network.online
      }
    )
  }

  private async pullChangesPage(
    changes: RecordChangesResponse,
    runState: PullRunState,
    nextCursor: string
  ): Promise<{ stop: PageStopReason; cursorCommitted: boolean }> {
    // Fetched before any slice transaction opens: that apply loop stays
    // synchronous (bulk-apply.ts), so the page's bodies must be in hand.
    const noteBodies = await this.noteBodyFeed.fetchPage(
      changes,
      runState,
      runState.vaultKey,
      !runState.fromZero
    )
    if (noteBodies?.keyStop) return { stop: noteBodies.keyStop, cursorCommitted: false }
    const slices = planPullSlices(changes)
    const { bodies = [], refused = [], owed = [] } = noteBodies ?? {}
    if (slices.length === 0 && bodies.length + refused.length + owed.length > 0) {
      slices.push({ fetchIds: [], inline: [] })
    }
    if (slices.length === 0) return { stop: 'none', cursorCommitted: false }
    if (noteBodies) slices[slices.length - 1].noteBodies = noteBodies
    const skippedForRecord = noteBodies?.skippedForRecord
    if (skippedForRecord) for (const slice of slices) slice.skippedForRecord = skippedForRecord
    runState.latency.observePage(changes)

    // A changes page holds up to PULL_PAGE_LIMIT (500) refs, but POST
    // /sync/pull accepts at most PULL_REQUEST_MAX_IDS (100) ids, so the page is
    // pulled in slices — which also keeps decrypt/apply memory at the profile
    // it had when the page size WAS 100. Stop semantics per slice:
    // - The cursor never moves before the page's LAST slice (#2294). A crash
    //   or throw before it leaves the cursor on the previous page, so the
    //   whole page re-pulls; slices that already committed are equal-clock,
    //   identical-payload re-deliveries and skip. The last slice commits the
    //   cursor with its rows only when no slice of the page has post-commit
    //   work (see `processPage`); otherwise `pullChanges` writes it after.
    // - HOLDS_CURSOR stops return immediately, before the last slice, so the
    //   cursor holds and unpulled slices re-arrive next cycle.
    // - 'breaker' must NOT abort the remaining slices: the cursor then
    //   advances past the WHOLE page, so a slice skipped here would neither
    //   be re-pulled nor marked corrupt — silent loss. Every slice runs (each
    //   marks its own failures), then the breaker is reported.
    let breakerTripped = false
    let postCommitWork = false
    let cursorCommitted = false
    const listedCursor = listedCursorOf(changes)
    for (const [index, slice] of slices.entries()) {
      const inSliceCursor = index === slices.length - 1 && !postCommitWork ? nextCursor : null
      const pageResult = await this.processPage(slice, runState, inSliceCursor, listedCursor)
      runState.pulledCount += pageResult.applied
      runState.totalConflictsResolved += pageResult.conflicts
      postCommitWork ||= pageResult.postCommitWork === true
      cursorCommitted ||= pageResult.cursorCommitted === true
      await this.applyCrdtBatch(runState)

      if (HOLDS_CURSOR.has(pageResult.stop)) {
        return { stop: pageResult.stop, cursorCommitted: false }
      }
      if (pageResult.stop === 'breaker') breakerTripped = true
    }

    return { stop: breakerTripped ? 'breaker' : 'none', cursorCommitted }
  }

  private async applyCrdtBatch(runState: PullRunState): Promise<void> {
    if (runState.crdtNoteIds.length === 0 || !this.ctx.deps.crdtProvider) return

    // Bootstrap only: let the CRDT doc cache hold a whole batch-endpoint page
    // worth of docs, so the cold apply runs in 100-doc sub-chunks instead of
    // 32-doc ones (applyCrdtBatch sub-chunks at inactiveDocCapacity). The
    // paced vault sweep is blocked while fullSyncActive, so no concurrent
    // batch pass sizes itself against the raised capacity and then loses docs
    // when it reverts. Reverted in the finally — the revert itself evicts back
    // down to the steady-state limit, flushing each doc on the way out.
    const restoreCapacity = this.ctx.fullSyncActive
      ? this.ctx.deps.crdtProvider.raiseInactiveDocCapacity(BOOTSTRAP_CRDT_INACTIVE_DOC_LIMIT)
      : null

    runState.timer.startPhase('crdt-batch')
    try {
      await this.crdtSync.applyCrdtBatch(
        runState.crdtNoteIds,
        runState.accessJwt,
        runState.vaultKey
      )
    } finally {
      runState.timer.endPhase(runState.crdtNoteIds.length)
      runState.crdtNoteIds.length = 0
      if (restoreCapacity) await restoreCapacity()
    }
  }

  private emitInitialSyncProgress(changes: RecordChangesResponse, pulledCount: number): void {
    if (!this.ctx.fullSyncActive) return

    const estimatedTotal = changes.hasMore
      ? pulledCount + this.ctx.options.pullPageLimit
      : pulledCount
    this.ctx.deps.emitToRenderer(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
      phase: 'notes',
      processedItems: pulledCount,
      totalItems: estimatedTotal
    } satisfies InitialSyncProgressEvent)
  }

  private finalizePullSuccess(runState: PullRunState): void {
    log.info('Pull timing', runState.timer.finish())
    this.stateManager.recordHistory('pull', runState.pulledCount, Date.now() - runState.startTime)
    this.stateManager.updateLastSyncAt()
    this.ctx.rateLimitConsecutive = 0

    if (runState.totalConflictsResolved > 0) {
      log.info('Pull: re-enqueued merged items for push-back', {
        conflicts: runState.totalConflictsResolved
      })
      this.ctx.requestPush()
    }

    if (runState.pulledCount > 0) {
      void import('../../vault/property-definitions')
        .then(({ PropertyDefinitionsService }) => {
          const service = PropertyDefinitionsService.get()
          service.reload().catch((err: unknown) => {
            log.warn('Failed to reload property definitions after pull:', err)
          })
        })
        .catch(() => {
          // Service not initialized yet — skip
        })
    }
  }

  private handlePullError(error: unknown, startedAt: number): void {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log.debug('Pull aborted (likely network change)')
      return
    }

    const errorInfo = classifyError(error)
    this.ctx.lastErrorInfo = errorInfo
    this.ctx.lastError = errorInfo.message
    if (
      errorInfo.category === 'device_revoked' ||
      errorInfo.category === 'auth_expired' ||
      errorInfo.category === 'network_offline' ||
      error instanceof RateLimitError
    ) {
      throw error
    }

    // Swallowed here, so engine.pull() records sync_run_completed success —
    // the sync_error for this terminal outcome must be emitted from inside
    // this handler.
    trackMainEvent('sync_error', {
      surface: 'sync',
      action: 'pull_failed',
      result: 'failed',
      ...syncErrorTelemetry(errorInfo),
      metrics: { durationMs: Date.now() - startedAt },
      source: 'pull',
      dimensions: { transport: 'record' }
    })
    this.stateManager.setState('error')
    this.stateManager.recordHistory('error', 0, Date.now() - startedAt, errorInfo.message)
  }

  private cleanupAfterPull(vaultKey: Uint8Array | null, cleanup: () => void): void {
    this.deviceKeyCache.clear()
    // Cooldown entries otherwise only expire when a later pull happens to
    // re-fetch the same item, so a burst of corruption that then stops leaves
    // the tracker holding every entry for the rest of the session. Sweeping
    // here is O(entries) once per pull and drops nothing that is still live.
    this.corruptTracker.clearExpired()
    try {
      if (vaultKey) secureCleanup(vaultKey)
    } finally {
      cleanup()
    }
  }

  /**
   * Re-apply items whose first apply threw. By the time every page has landed,
   * FK parents (projects, conversations, sources) exist locally, so ordering
   * failures from cursor-ordered pages resolve here. Items that fail again are
   * dropped until their next server-side update.
   */
  private async applyDeferredRetries(runState: PullRunState): Promise<void> {
    if (this.pendingApplyRetries.length === 0) return

    const retries = sortByApplyOrder(this.pendingApplyRetries)
    this.pendingApplyRetries = []
    let applied = 0
    let failed = 0

    for (let i = 0; i < retries.length; i++) {
      if (this.ctx.abortController?.signal.aborted) break
      if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop()
      const dec = retries[i]
      try {
        const { result, operation: itemOp } = applyDecryptedItem(
          this.ctx.applier,
          dec,
          runState.vaultKey
        )

        if (result === 'parse_error') {
          failed++
          continue
        }
        if (result === 'conflict') {
          reportConflict(this.ctx.deps, dec)
          runState.totalConflictsResolved++
        }

        this.queueBodyPull(runState, dec, itemOp)

        runState.applied.recordDeferred(dec)
        runState.pulledCount++
        applied++
        this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
      } catch (retryError) {
        failed++
        routeDeferredRetryFailure(dec, retryError, this.orphanedItems, this.schemaInvalid)
      }
    }

    log.info('Pull: deferred apply retries processed', { retried: retries.length, applied, failed })
  }

  /** See `repairOrphans` — resolves items left unwritable by a missing FK parent (#837). */
  private async repairOrphanedItems(runState: PullRunState): Promise<void> {
    const orphans = this.orphanedItems
    this.orphanedItems = []
    await repairOrphans({
      orphans,
      ctx: this.ctx,
      corruptTracker: this.corruptTracker,
      schemaInvalid: this.schemaInvalid,
      accessJwt: runState.accessJwt,
      vaultKey: runState.vaultKey,
      applyItem: (item) => this.applyOrphan(item, runState)
    })
  }

  private applyOrphan(dec: DecryptedPullItem, runState: PullRunState): void {
    const { result, operation: itemOp } = applyDecryptedItem(
      this.ctx.applier,
      dec,
      runState.vaultKey
    )
    // The requeue is what carries a merged row back to the server (#2180).
    // Not counted in `totalConflictsResolved`: that number is the pull's own
    // per-page tally, and a repair pass runs after the last page is logged.
    if (result === 'schema_invalid') return this.schemaInvalid.record([dec], 'payload')
    if (result === 'conflict') reportConflict(this.ctx.deps, dec)
    this.queueBodyPull(runState, dec, itemOp)
    runState.applied.recordDeferred(dec)
    runState.pulledCount++
    this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
  }

  /**
   * An applied note or journal record: owed its whole body (#2297), which the
   * next CRDT batch pulls. On a record page the debt commits with the page,
   * ahead of any cursor write (#2294).
   */
  private queueBodyPull(
    runState: PullRunState,
    dec: { id: string; type: string; content: string },
    op: string
  ): void {
    if (!this.ctx.deps.crdtProvider || !carriesCrdtBody(dec, op)) return
    this.crdtSync.oweRecordBody(dec.id)
    runState.crdtNoteIds.push(dec.id)
  }

  /**
   * `pageCursor` is set only for a page's last slice. It commits with the
   * slice's rows (#2294) only when nothing still has to run after that commit
   * for the page to count as applied; `postCommitWork` reports that, and
   * `cursorCommitted` whether the cursor went in. `listedCursor` ranks each id
   * against the run's earlier applies (#2429).
   */
  private async processPage(
    { fetchIds, inline, noteBodies, skippedForRecord }: PullSlice,
    runState: PullRunState,
    pageCursor: string | null,
    listedCursor: (id: string) => number
  ): Promise<{
    applied: number
    conflicts: number
    stop: PageStopReason
    postCommitWork?: boolean
    cursorCommitted?: boolean
  }> {
    const { vaultKey, timer, applied, crdtNoteIds } = runState
    const requestedCount = fetchIds.length + inline.length
    const pullBody = await fetchSliceBody(this.ctx, runState, fetchIds)

    const parsed = parsePullItems(pullBody, inline, fetchIds)
    if (parsed.kind === 'not_envelope') {
      log.error('Invalid pull response from server: not a pull envelope')
      log.warn('pull_page_dropped', {
        reason: 'invalid_pull_response',
        droppedCount: requestedCount
      })
      // The cursor holds (#2285); without an error state the stall is invisible.
      this.ctx.lastError = 'The sync server returned an invalid pull response.'
      this.ctx.lastErrorInfo = {
        category: 'server_error',
        message: this.ctx.lastError,
        retryable: true
      }
      this.stateManager.setState('error')
      trackMainEvent('sync_error', {
        surface: 'sync',
        action: 'pull_page_dropped',
        result: 'failed',
        errorCode: 'invalid_pull_response',
        metrics: { itemCount: requestedCount },
        source: 'pull',
        dimensions: { transport: 'record' }
      })
      return { applied: 0, conflicts: 0, stop: 'invalid_response' }
    }

    if (parsed.unnamed > 0)
      log.error('Pull: dropped items with no id or type', { count: parsed.unnamed })
    log.debug('Pull: response parsed', {
      requestedCount,
      receivedCount: parsed.items.length
    })

    // Bootstrap throughput (#1835), UNITS: this channel counts base64
    // CHARACTERS (`String.length` of `encryptedData` + `encryptedKey`), which
    // are ~0.75x the actual octets on the wire. The crdt snapshot site and the
    // attachments channel count real byteLength/octet totals instead — do not
    // compare per-second rates across channels naively. Aggregated in memory;
    // no-op outside a fresh-device bootstrap window.
    recordBootstrapBytes(
      'records',
      parsed.items.reduce(
        (sum, item) => sum + item.blob.encryptedData.length + item.blob.encryptedKey.length,
        0
      )
    )

    const signerIds = new Set(parsed.items.map((i) => i.signerDeviceId))
    await Promise.all(Array.from(signerIds).map((sid) => this.resolveDeviceKey(sid)))
    log.debug('Pull: device keys prefetched', { signerCount: signerIds.size })

    let pageApplied = 0
    let pageSkipped = 0
    let pageFailed = 0
    const refused: ItemRef[] = []
    const settled: ItemRef[] = []
    let cryptoFailCount = 0
    let pageConflicts = 0

    const itemsToProcess = parsed.items.filter((item) => {
      if (applied.covers(item, listedCursor(item.id))) {
        pageSkipped++
        return false
      }
      if (this.quarantine.isQuarantined(item.id, item.type)) {
        pageSkipped++
        return false
      }
      return true
    })
    // #2302: purged tombstones need no decrypt; they join the apply loop as deletes.
    const purged = await purgedTombstoneApplyItems(
      parsed,
      (t) =>
        runState.fromZero === true ||
        applied.covers(t, listedCursor(t.id)) ||
        this.quarantine.isQuarantined(t.id, t.type),
      { db: this.ctx.deps.db, resolveKey: (id) => this.resolveDeviceKey(id) }
    )

    timer.startPhase('encrypt')
    const { decrypted, failures } = await decryptPullBatch(itemsToProcess, vaultKey, {
      workerBridge: this.ctx.deps.workerBridge,
      resolveDeviceKey: (id) => this.resolveDeviceKey(id)
    })
    timer.endPhase(itemsToProcess.length)

    // When EVERY item in the page fails to decrypt or verify, per-item
    // corruption is not a plausible explanation — the vault key itself is the
    // suspect (e.g. this device's master key no longer matches the account).
    // Confirm against the account verifier before branding anything: a
    // confirmed mismatch must not quarantine items, mark them corrupt, or
    // toast security warnings — those side effects outlive the key problem and
    // keep scaring the user after recovery. Stop the cycle and escalate once.
    const everyItemFailed =
      itemsToProcess.length > 0 &&
      decrypted.length === 0 &&
      failures.length === itemsToProcess.length
    if (everyItemFailed && this.ctx.deps.checkAccountKey) {
      const keyCheck = await this.ctx.deps.checkAccountKey()
      if (keyCheck === 'mismatch') {
        this.ctx.lastError =
          'All items failed with crypto errors — possible vault key mismatch. ' +
          `${failures.length} item(s) could not be decrypted.`
        this.ctx.lastErrorInfo = {
          category: 'crypto_failure',
          message: this.ctx.lastError,
          retryable: false
        }
        this.stateManager.setState('error')
        log.error(
          'Pull: vault key does not match the account — stopping cycle without recording item failures',
          { failedCount: failures.length }
        )
        // Ends the run as 'refused', never a throw — engine.pull() records a
        // success, so the incident-class event must be emitted here.
        trackMainEvent('sync_error', {
          surface: 'sync',
          action: 'vault_key_mismatch',
          result: 'failed',
          errorCode: 'vault_key_mismatch',
          metrics: { itemCount: failures.length },
          source: 'pull',
          dimensions: { transport: 'record' }
        })
        this.ctx.deps.onVaultKeyMismatch?.()
        return { applied: 0, conflicts: 0, stop: 'mismatch' }
      }
      if (keyCheck === 'transition') {
        // Sign-in / recovery / linking is mid-swap: the failures are expected
        // and momentary. Stop this cycle quietly — the flow restarts sync with
        // the settled key, and the next cycle re-pulls these items cleanly.
        log.info(
          'Pull: key material is being re-established — stopping cycle without recording item failures',
          { failedCount: failures.length }
        )
        return { applied: 0, conflicts: 0, stop: 'transition' }
      }
    }

    for (const failure of failures) {
      if (failure.isSignatureError) {
        this.quarantine.quarantineItem(
          failure.id,
          failure.type,
          failure.signerDeviceId,
          failure.error
        )
        pageFailed++
        continue
      }
      log.error('Pull: failed to process item', {
        itemId: failure.id,
        type: failure.type,
        signerDeviceId: failure.signerDeviceId,
        isCryptoError: failure.isCryptoError,
        error: failure.error
      })
      pageFailed++
      if (failure.isCryptoError) cryptoFailCount++
    }

    const parseErrorIds: Array<{ id: string; type: string }> = []

    timer.startPhase('apply')
    this.pushCoordinator.suppressPushDuringPull = true
    const orderedDecrypted = sortByApplyOrder([...decrypted, ...purged])
    // One SQLite transaction per page on both DBs, with note file writes
    // deferred until after the commit (crash-safety contract in bulk-apply.ts).
    // The loop below is deliberately synchronous while the transaction is open
    // — no event-loop yields — so nothing else in the main process can slip
    // statements into the page transaction. Per-item failures stay caught and
    // deferred exactly as before; only a throw that escapes the whole loop
    // rolls the page back, and that same throw stops the cursor from
    // advancing, so the page is re-pulled intact. Renderer events wait for
    // the commit (#2294).
    const pageApply = beginPageApply(this.ctx.deps.db)
    let postCommitWork = false
    let cursorCommitted = false
    const conflictDeps = {
      ...this.ctx.deps,
      emitToRenderer: (channel: string, event: unknown) =>
        pageApply.afterCommit(() => this.ctx.deps.emitToRenderer(channel, event))
    }
    try {
      try {
        for (let i = 0; i < orderedDecrypted.length; i++) {
          if (this.ctx.abortController?.signal.aborted) break
          const dec = orderedDecrypted[i]
          try {
            const { result, operation: itemOp } = applyDecryptedItem(
              this.ctx.applier,
              dec,
              vaultKey,
              pageApply
            )

            if (result === 'parse_error') {
              parseErrorIds.push({ id: dec.id, type: dec.type })
              pageFailed++
              continue
            }
            if (result === 'schema_invalid') {
              refused.push(dec)
              pageFailed++
              continue
            }
            settled.push(dec)
            runState.latency.noteApplied(dec, result)

            if (result === 'conflict') {
              reportConflict(conflictDeps, dec)
              pageConflicts++
            }

            this.queueBodyPull(runState, dec, itemOp)

            applied.record(dec, listedCursor(dec.id))
            pageApplied++
            // A skipped row changed nothing, and every ITEM_SYNCED makes the
            // renderer refetch (the task list re-queries per event).
            if (result !== 'skipped') {
              pageApply.afterCommit(() =>
                this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
              )
            }
          } catch (applyError) {
            log.error('Pull: failed to apply decrypted item — deferring for retry', {
              itemId: dec.id,
              type: dec.type,
              error: applyError instanceof Error ? applyError.message : String(applyError),
              ...(applyError instanceof MissingSyncParentError
                ? { parentType: applyError.parentType, parentId: applyError.parentId }
                : {})
            })
            this.pendingApplyRetries.push(dec)
            applied.defer(dec, listedCursor(dec.id))
            pageFailed++
          }
        }
        this.schemaInvalid.record(refused, 'payload')
        this.schemaInvalid.record(parsed.invalid, 'envelope')
        this.schemaInvalid.record(parsed.blobMissing, 'blob_missing')
        this.schemaInvalid.resolve(settled)
        // Before this slice's CRDT batch, which settles them (#2297 round 2 b-M2).
        this.noteBodyFeed.oweSkippedForRecords(skippedForRecord, settled)
        if (noteBodies) this.noteBodyFeed.recordInPage(noteBodies)
        // After the commit still run: the corrupt re-fetch and its recovered
        // applies, the CRDT batch, and deferred retries. A cursor committed
        // ahead of them survives a crash that loses them, and nothing re-pulls
        // the page. Nor can an untransacted page make the cursor atomic.
        postCommitWork =
          failures.some((f) => f.isCryptoError) ||
          parseErrorIds.length > 0 ||
          crdtNoteIds.length > 0 ||
          (noteBodies?.bodies.length ?? 0) > 0 ||
          this.pendingApplyRetries.length > 0
        // The page's last statement: the cursor commits with the page's last
        // rows or not at all (#2294, protocol 05 §5.11), and never after an
        // abort broke the loop above.
        if (
          pageCursor !== null &&
          !postCommitWork &&
          pageApply.transacted &&
          !this.ctx.abortController?.signal.aborted
        ) {
          this.stateManager.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, pageCursor)
          cursorCommitted = true
        }
        pageApply.commit()
        runState.latency.flush()
      } catch (pageError) {
        pageApply.rollback()
        throw pageError
      }
    } finally {
      this.pushCoordinator.suppressPushDuringPull = false
    }
    timer.endPhase(decrypted.length)
    // After the commit, before the CRDT batch and the corrupt re-fetch: the
    // CRDT apply that follows this page seeds absent docs from markdown, so the
    // page's deferred note files must be on disk before it runs.
    await pageApply.flushFiles()
    // After the files, so a note created on this page is on disk when its body
    // is merged and written back. The cursor waits for this (postCommitWork),
    // so a crash before it re-pulls the page (#2297).
    if (noteBodies) await this.noteBodyFeed.land(noteBodies)

    const refetchRefs = [...failures.filter((f) => f.isCryptoError), ...parseErrorIds]
    if (refetchRefs.length > 0 && pageApplied > 0) {
      const onChanged = (dec: RecoveredItem, itemOp: 'create' | 'update' | 'delete'): void => {
        this.queueBodyPull(runState, dec, itemOp)
        applied.record(dec, listedCursor(dec.id))
        pageApplied++
        pageFailed--
        this.stateManager.emitItemSynced(dec.id, dec.type, 'pull', itemOp)
      }
      await refetchCorruptItems(
        this.recoveryDeps(onChanged),
        refetchRefs.map(({ id, type }) => ({ id, type })),
        runState.accessJwt,
        vaultKey
      )
    }

    log.info('Pull page processed', {
      total: parsed.items.length,
      applied: pageApplied,
      skipped: pageSkipped,
      failed: pageFailed,
      conflicts: pageConflicts
    })

    let stop: PageStopReason = 'none'
    if (
      pageFailed > 0 &&
      pageFailed === cryptoFailCount &&
      parsed.items.length > 0 &&
      pageApplied === 0
    ) {
      tripPullBreaker(
        { ctx: this.ctx, stateManager: this.stateManager, corruptTracker: this.corruptTracker },
        failures,
        cryptoFailCount
      )
      stop = 'breaker'
    }

    return { applied: pageApplied, conflicts: pageConflicts, stop, postCommitWork, cursorCommitted }
  }
}
