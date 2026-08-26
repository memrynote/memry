/**
 * The batched half of the CRDT snapshot push.
 *
 * `POST /sync/crdt/snapshot` carries exactly one note, and a seeded vault
 * pushes one per body: 100 notes measured at ~750ms each (~600ms server-side)
 * = 15 seconds of serialised round trips. `POST /sync/crdt/snapshot/batch`
 * carries up to MAX_CRDT_SNAPSHOT_BATCH_ENTRIES of them, so the same work is a
 * couple of requests.
 *
 * Lives outside `runtime.ts` because everything below has to be testable
 * without standing up a sync runtime — the 404 fallback in particular, which is
 * the path a user on an older sync server takes forever.
 */
import { createLogger } from '../lib/logger'
import { secureCleanup } from '../crypto/index'
import { withRetry } from '@memry/sync-client/retry'
import { MAX_CRDT_SNAPSHOT_BATCH_ENTRIES } from '@memry/sync-client/crdt-payload'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { pushCrdtSnapshotBatch, SyncServerError } from './http-client'
import { withAuthRetry, type AuthRetryDeps } from './auth-retry'
import type { SnapshotBatchEntry, SnapshotBatchPushFn, SnapshotPushFn } from './crdt-provider'

const log = createLogger('CrdtSnapshotBatch')

export interface CrdtSnapshotBatchDeps {
  /** The single-note push. Every fallback in here goes through it, so the
   * endpoint choice, the 401/413 handling and the retry budget stay in one
   * place. Rejects on failure, exactly as `SnapshotPushFn` documents. */
  pushSingle: SnapshotPushFn
  /**
   * "This device has not merged what the server holds for that note."
   *
   * The batch endpoint is the destructive one: like `/sync/crdt/snapshot` it
   * overwrites the note's blob and prunes every device's `crdt_updates` rows at
   * or below the new watermark. A note this returns `true` for must therefore
   * never ride it — same reasoning, same consequence and the same #1503
   * incident as the single-note path, which routes those to
   * `/sync/crdt/updates` instead. Batching does not get to skip the check.
   */
  hasUnmergedRemoteState: (noteId: string) => boolean
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKey: () => Promise<Uint8Array | null>
  authRetryDeps: AuthRetryDeps
  /** Called with the raw error for a whole-batch failure, so the runtime can do
   * what it already does for a single push: pause the queue on 401, surface a
   * quota error on 413. */
  onBatchError?: (err: unknown) => void
}

/**
 * Build the provider's `SnapshotBatchPushFn`.
 *
 * The returned fn is TOTAL: it never rejects and always answers for every note
 * it was handed. A note that answers `false` is one the provider must keep
 * pending — that is the only channel by which a per-note `accepted: false`
 * reaches the retry machinery.
 *
 * The old-server capability is latched on this closure, so it is per sync
 * runtime — the same lifetime and the same mechanism as
 * `CrdtSyncCoordinator.snapshotMetaUnsupported`. One wasted 404 per session,
 * then the per-note path with no further probing.
 */
export function createCrdtSnapshotBatchPush(deps: CrdtSnapshotBatchDeps): SnapshotBatchPushFn {
  let batchEndpointUnsupported = false

  const pushOneByOne = async (
    entries: SnapshotBatchEntry[],
    results: Map<string, boolean>
  ): Promise<void> => {
    for (const entry of entries) {
      try {
        await deps.pushSingle(entry.noteId, entry.state)
        results.set(entry.noteId, true)
      } catch (err) {
        log.warn('Single-note CRDT snapshot push failed', { noteId: entry.noteId, error: err })
        results.set(entry.noteId, false)
      }
    }
  }

  return async (entries: SnapshotBatchEntry[]): Promise<Map<string, boolean>> => {
    const results = new Map<string, boolean>()
    if (entries.length === 0) return results

    // Split before anything else: an unmerged note is not eligible for the
    // batch at any point, whether or not the server supports it.
    const batchable: SnapshotBatchEntry[] = []
    const unmerged: SnapshotBatchEntry[] = []
    for (const entry of entries) {
      if (deps.hasUnmergedRemoteState(entry.noteId)) unmerged.push(entry)
      else batchable.push(entry)
    }
    if (unmerged.length > 0) {
      log.debug('Routing unmerged notes around the snapshot batch', { count: unmerged.length })
      await pushOneByOne(unmerged, results)
    }

    if (batchable.length === 0) return results
    if (batchEndpointUnsupported) {
      await pushOneByOne(batchable, results)
      return results
    }

    let token = await deps.getAccessToken()
    const vaultKey = await deps.getVaultKey()
    const signingSecretKey = await deps.getSigningKey()
    if (!token || !vaultKey || !signingSecretKey) {
      log.warn('Missing credentials for the batched CRDT snapshot push', {
        count: batchable.length,
        authAvailable: !!token,
        hasVaultKey: !!vaultKey,
        hasSigningKey: !!signingSecretKey
      })
      if (vaultKey) secureCleanup(vaultKey)
      if (signingSecretKey) secureCleanup(signingSecretKey)
      // Not a throw: the notes stay pending because they answer `false`, which
      // is what the provider needs. Throwing would only skip its bookkeeping.
      for (const entry of batchable) results.set(entry.noteId, false)
      return results
    }

    try {
      for (let i = 0; i < batchable.length; i += MAX_CRDT_SNAPSHOT_BATCH_ENTRIES) {
        // The provider already chunks at this size, so in practice there is one
        // slice. Re-slicing here is what makes the wire cap this module's
        // problem rather than every caller's.
        const slice = batchable.slice(i, i + MAX_CRDT_SNAPSHOT_BATCH_ENTRIES)

        if (batchEndpointUnsupported) {
          await pushOneByOne(slice, results)
          continue
        }

        const encrypted = slice.map((entry) => ({
          noteId: entry.noteId,
          snapshot: encryptCrdtUpdate(entry.state, vaultKey, entry.noteId, signingSecretKey)
        }))

        try {
          const response = await withRetry(
            () =>
              withAuthRetry(
                (authToken) => pushCrdtSnapshotBatch(encrypted, authToken),
                token!,
                deps.authRetryDeps,
                (fresh) => {
                  token = fresh
                }
              ),
            { maxRetries: 3, baseDelayMs: 2000 }
          )

          for (const result of response.value.results ?? []) {
            results.set(result.noteId, result.accepted === true)
            if (result.accepted !== true) {
              log.warn('Server rejected a snapshot inside a batch', {
                noteId: result.noteId,
                reason: result.reason
              })
            }
          }
          // A note the response never mentioned did not land. Defaulting to
          // `false` keeps it pending; defaulting the other way would drop a
          // body with nothing left to retry it.
          for (const entry of slice) {
            if (!results.has(entry.noteId)) results.set(entry.noteId, false)
          }
          log.debug('Pushed a CRDT snapshot batch', { count: slice.length })
        } catch (err) {
          if (err instanceof SyncServerError && err.statusCode === 404) {
            // The capability signal. A server that predates the endpoint
            // answers 404 for it and 200 for the single-note one, so the
            // fallback is not a degradation — it is what this build did before
            // the batch existed. Latched for the session so the rest of the
            // vault does not pay a 404 per batch.
            batchEndpointUnsupported = true
            log.info('Sync server has no batched snapshot endpoint; using the per-note path')
            await pushOneByOne(slice, results)
            continue
          }

          if (err instanceof SyncServerError && err.statusCode === 413) {
            // A body limit hit by the AGGREGATE says nothing about which note is
            // too large. The per-note path is the thing that can tell — and its
            // 413 handling is what names the offending note to the user.
            log.warn('Batched CRDT snapshot push was too large; retrying per note', {
              count: slice.length
            })
            await pushOneByOne(slice, results)
            continue
          }

          log.warn('Batched CRDT snapshot push failed', { count: slice.length, error: err })
          deps.onBatchError?.(err)
          for (const entry of slice) results.set(entry.noteId, false)
        }
      }
    } finally {
      secureCleanup(vaultKey)
      secureCleanup(signingSecretKey)
    }

    return results
  }
}
