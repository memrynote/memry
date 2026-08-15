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

  constructor(ctx: SyncContext, resolveDeviceKey: ResolveDeviceKey) {
    this.ctx = ctx
    this.resolveDeviceKey = resolveDeviceKey
  }

  addPendingPull(noteId: string): void {
    this.pendingPulls.add(noteId)
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
   */
  private owePendingPull(noteId: string): void {
    this.pendingPulls.add(noteId)
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
  }

  private rememberAppliedSequence(noteId: string, sequenceNum: number): number {
    const known = this.lastAppliedSequence.get(noteId) ?? 0
    const next = Math.max(known, sequenceNum)
    this.lastAppliedSequence.set(noteId, next)
    return next
  }

  private async applySnapshotBaseline(
    noteId: string,
    token: string,
    vaultKey: Uint8Array,
    mode: 'single' | 'batch'
  ): Promise<number> {
    const snapshotResult = await fetchCrdtSnapshot(noteId, token)
    if (!snapshotResult || !this.ctx.deps.crdtProvider) {
      return 0
    }

    const signerPubKey = await this.resolveDeviceKey(snapshotResult.signerDeviceId)
    if (!signerPubKey) {
      log.warn(`Skipping CRDT snapshot from unresolvable signer in ${mode} mode`, {
        noteId,
        signerDeviceId: snapshotResult.signerDeviceId
      })
      return 0
    }

    const decrypted = decryptCrdtUpdate(snapshotResult.snapshot, vaultKey, noteId, signerPubKey)
    this.ctx.deps.crdtProvider.applyRemoteUpdate(noteId, decrypted)
    const baselineSequence = this.rememberAppliedSequence(noteId, snapshotResult.sequenceNum)
    log.debug('Applied CRDT snapshot baseline', {
      noteId,
      mode,
      sequenceNum: snapshotResult.sequenceNum
    })
    return baselineSequence
  }

  async applyCrdtIncrementals(
    noteId: string,
    token: string,
    vaultKey: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider) return

    const effectiveSignal = signal ?? this.ctx.abortController?.signal
    if (!effectiveSignal) return

    const wasOpen = crdtProvider.getDoc(noteId) != null
    try {
      const doc = await crdtProvider.open(noteId, undefined, { skipSeed: true })
      if (!doc) return

      let since = await this.applySnapshotBaseline(noteId, token, vaultKey, 'single')

      let hasMore = true

      while (hasMore) {
        if (effectiveSignal.aborted) {
          log.debug('applyCrdtIncrementals aborted', { noteId, lastSeq: since })
          return
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
            since = entry.sequenceNum
            continue
          }

          const decrypted = decryptCrdtUpdate(packed, vaultKey, noteId, signerPubKey)
          crdtProvider.applyRemoteUpdate(noteId, decrypted)
          since = this.rememberAppliedSequence(noteId, entry.sequenceNum)
        }

        hasMore = result.hasMore
      }

      const postVector = crdtProvider.getStateVector(noteId)
      if (!postVector || postVector.length <= 2) {
        await crdtProvider.seedFromMarkdownPublic(noteId)
        log.debug('applyCrdtIncrementals: seeded from markdown as fallback (no server CRDT)', {
          noteId
        })
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.debug('applyCrdtIncrementals aborted via signal', { noteId })
        return
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
          continue
        }

        try {
          const since = await this.applySnapshotBaseline(noteId, token, vaultKey, 'batch')
          sinceMap.set(noteId, since)
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
        if (signal.aborted) return

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
            activeSince.delete(noteId)
          }
        }
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

  async pullCrdtForNote(noteId: string): Promise<void> {
    log.debug('pullCrdtForNote entered', { noteId })
    const token = await this.ctx.deps.getAccessToken()
    if (!token) return

    const vaultKey = await this.ctx.deps.getVaultKey()
    if (!vaultKey) return

    const localAbort = new AbortController()
    try {
      await this.applyCrdtIncrementals(noteId, token, vaultKey, localAbort.signal)
      log.debug('pullCrdtForNote completed', { noteId })
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
