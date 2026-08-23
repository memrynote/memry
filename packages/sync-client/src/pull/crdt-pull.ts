import type { SyncLogger } from '../adapters/logger.ts'
import { withRetry } from '../retry.ts'
import type { SyncCryptoProvider } from './crypto-provider.ts'
import { decryptCrdtUpdatePacked } from './record-decrypt.ts'
import { seamJsonRequest, type SeamHttpContext } from './http.ts'
import type { CrdtPullStore } from './store.ts'

/**
 * Pull-only CRDT body sync. Note/journal bodies never travel in the record
 * feed (update pushes carry `content: null`), so this path is how a mobile
 * device sees body edits at all. Mirrors desktop's read semantics
 * (`CrdtSyncCoordinator.applySnapshotBaseline` + `applyCrdtIncrementals`):
 * snapshot baseline when needed, then `since`-ordered incrementals, decrypted
 * per update and persisted durably before the sequence watermark advances.
 *
 * Deliberately absent (pull-only scope): snapshot pushes, the probe's
 * "fully merged" bookkeeping, and pending-note replay — those exist to guard
 * the WRITE path and arrive with Phase 4.
 *
 * One deviation from desktop, on the safe side: desktop advances `since` past
 * an update whose signer cannot be resolved and owes the note a re-pull; here
 * the note's pull STOPS at that update (watermark not advanced past it), so a
 * later pass retries and no update can be skipped permanently.
 */

const CRDT_BATCH_MAX_NOTES = 100
const CRDT_UPDATES_PAGE_LIMIT = 100

interface CrdtUpdateEntry {
  sequenceNum: number
  data: string
  createdAt: number
  signerDeviceId: string
}

interface CrdtBatchPullResponse {
  notes: Record<string, { updates: CrdtUpdateEntry[]; hasMore: boolean }>
  snapshotMeta?: Record<string, { sequenceNum: number; revision: string; signerDeviceId: string }>
}

interface CrdtSnapshotResponse {
  snapshot: string | null
  sequenceNum: number
  signerDeviceId: string | null
  revision?: string | null
}

export interface CrdtPullDeps {
  httpCtx: () => SeamHttpContext
  crypto: SyncCryptoProvider
  store: CrdtPullStore
  resolveDeviceKey: (deviceId: string) => Promise<Uint8Array | null>
  getVaultKey: () => Uint8Array | null
  log: SyncLogger
  isOnline?: () => boolean
  signal?: AbortSignal
  /** Called after a note's body state changed on disk (materialize previews). */
  onNoteBodyChanged?: (noteId: string) => Promise<void> | void
}

export interface CrdtPullResult {
  notesUpdated: number
  notesFailed: number
}

export class CrdtBodyPuller {
  constructor(private readonly deps: CrdtPullDeps) {}

  private retryOpts() {
    return {
      maxRetries: 3,
      baseDelayMs: 2000,
      signal: this.deps.signal,
      isOnline: this.deps.isOnline,
      retryOn429: false
    }
  }

  async pullBodies(noteIds: string[]): Promise<CrdtPullResult> {
    const result: CrdtPullResult = { notesUpdated: 0, notesFailed: 0 }
    const vaultKey = this.deps.getVaultKey()
    if (!vaultKey || noteIds.length === 0) return result

    for (let i = 0; i < noteIds.length; i += CRDT_BATCH_MAX_NOTES) {
      if (this.deps.signal?.aborted) break
      const chunk = noteIds.slice(i, i + CRDT_BATCH_MAX_NOTES)

      const sinceById = new Map<string, number>()
      for (const noteId of chunk) {
        sinceById.set(noteId, await this.deps.store.getNoteSince(noteId))
      }

      let batchResult: CrdtBatchPullResponse | null = null
      try {
        batchResult = await withRetry(
          () =>
            seamJsonRequest<CrdtBatchPullResponse>(this.deps.httpCtx(), {
              method: 'POST',
              path: '/sync/crdt/updates/batch',
              body: {
                notes: chunk.map((noteId) => ({ noteId, since: sinceById.get(noteId) ?? 0 })),
                limit: CRDT_UPDATES_PAGE_LIMIT
              }
            }),
          this.retryOpts()
        ).then((r) => r.value)
      } catch (err) {
        this.deps.log.warn('CRDT batch pull failed; notes retried next pass', {
          count: chunk.length,
          error: err instanceof Error ? err.message : String(err)
        })
        result.notesFailed += chunk.length
        continue
      }
      const batch = batchResult
      if (!batch) continue

      for (const noteId of chunk) {
        if (this.deps.signal?.aborted) break
        try {
          const changed = await this.pullOneNote(
            noteId,
            vaultKey,
            sinceById.get(noteId) ?? 0,
            batch.notes[noteId],
            batch.snapshotMeta?.[noteId]
          )
          if (changed) {
            result.notesUpdated++
            await this.deps.onNoteBodyChanged?.(noteId)
          }
        } catch (err) {
          result.notesFailed++
          this.deps.log.warn('CRDT body pull failed for note', {
            noteId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    return result
  }

  private async pullOneNote(
    noteId: string,
    vaultKey: Uint8Array,
    since: number,
    batchEntry: { updates: CrdtUpdateEntry[]; hasMore: boolean } | undefined,
    snapshotMeta: { sequenceNum: number; revision: string } | undefined
  ): Promise<boolean> {
    let changed = false
    let cursor = since

    // Baseline rule: a server prune means updates at or below the snapshot
    // watermark are answered with silence, so a `since` under the watermark
    // MUST take the snapshot first. Cold notes (since 0) always do; warm notes
    // do whenever the server's advertised watermark is ahead, or when an old
    // server advertises nothing and we cannot know (fetch, exactly as desktop
    // did before the revision token existed).
    const localRevision = await this.deps.store.getSnapshotRevision(noteId)
    const needBaseline =
      cursor === 0 ||
      (snapshotMeta
        ? snapshotMeta.sequenceNum > cursor && snapshotMeta.revision !== localRevision
        : false)

    if (needBaseline) {
      const snap = await withRetry(
        () =>
          seamJsonRequest<CrdtSnapshotResponse>(this.deps.httpCtx(), {
            method: 'GET',
            path: `/sync/crdt/snapshot/${encodeURIComponent(noteId)}`
          }),
        this.retryOpts()
      ).then((r) => r.value)

      if (snap.snapshot && snap.signerDeviceId) {
        const signerKey = await this.deps.resolveDeviceKey(snap.signerDeviceId)
        if (!signerKey) {
          throw new Error(`unresolvable snapshot signer ${snap.signerDeviceId}`)
        }
        const packed = this.deps.crypto.fromBase64(snap.snapshot)
        const decrypted = await decryptCrdtUpdatePacked(
          this.deps.crypto,
          packed,
          vaultKey,
          noteId,
          signerKey
        )
        await this.deps.store.saveSnapshot(
          noteId,
          decrypted,
          snap.sequenceNum,
          snap.revision ?? null
        )
        if (snap.sequenceNum > cursor) {
          cursor = snap.sequenceNum
          await this.deps.store.setNoteSince(noteId, cursor)
        }
        changed = true
      }
    }

    // Batch response covers the first page when our cursor matches what we
    // asked with; otherwise (baseline moved it) fall through to the loop.
    let pending: { updates: CrdtUpdateEntry[]; hasMore: boolean } | undefined =
      cursor === since ? batchEntry : undefined
    let hasMore = true

    while (hasMore) {
      if (this.deps.signal?.aborted) break

      const page: { updates: CrdtUpdateEntry[]; hasMore: boolean } =
        pending ??
        (await withRetry(
          () =>
            seamJsonRequest<{ updates: CrdtUpdateEntry[]; hasMore: boolean }>(this.deps.httpCtx(), {
              method: 'GET',
              path: `/sync/crdt/updates?note_id=${encodeURIComponent(noteId)}&since=${cursor}&limit=${CRDT_UPDATES_PAGE_LIMIT}`
            }),
          this.retryOpts()
        ).then((r) => r.value))

      for (const entry of page.updates) {
        if (entry.sequenceNum <= cursor) continue
        const signerKey = await this.deps.resolveDeviceKey(entry.signerDeviceId)
        if (!signerKey) {
          // Stop at the gap — do not advance the watermark past an update we
          // could not verify; a later pass retries from here.
          this.deps.log.warn('CRDT update signer unresolvable; note pull stops at gap', {
            noteId,
            sequenceNum: entry.sequenceNum,
            signerDeviceId: entry.signerDeviceId
          })
          return changed
        }
        const packed = this.deps.crypto.fromBase64(entry.data)
        const decrypted = await decryptCrdtUpdatePacked(
          this.deps.crypto,
          packed,
          vaultKey,
          noteId,
          signerKey
        )
        await this.deps.store.appendUpdate(noteId, decrypted, entry.sequenceNum)
        cursor = entry.sequenceNum
        await this.deps.store.setNoteSince(noteId, cursor)
        changed = true
      }

      hasMore = page.hasMore
      pending = undefined
    }

    return changed
  }
}
