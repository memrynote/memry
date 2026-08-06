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

  drainPendingPulls(): string[] {
    const ids = Array.from(this.pendingPulls)
    this.pendingPulls.clear()
    return ids
  }

  get pendingPullCount(): number {
    return this.pendingPulls.size
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

  async applyCrdtBatch(noteIds: string[], token: string, vaultKey: Uint8Array): Promise<void> {
    const crdtProvider = this.ctx.deps.crdtProvider
    if (!crdtProvider || !this.ctx.abortController) return

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
          // the pass. Skip it; the next pass retries it.
          log.warn('Failed to apply CRDT snapshot baseline, skipping note in batch', {
            noteId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      if (sinceMap.size === 0) return

      const activeSince = new Map(sinceMap)

      while (activeSince.size > 0) {
        if (this.ctx.abortController.signal.aborted) return

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
            signal: this.ctx.abortController.signal,
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
        if (!postVector || postVector.length <= 2) {
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
}
