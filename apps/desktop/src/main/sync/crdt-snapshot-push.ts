/**
 * The single-note CRDT snapshot push, and the one place that chooses between
 * the pruning snapshot endpoint and the non-pruning update endpoint.
 *
 * Lives outside `runtime.ts` so the routing is testable without a sync runtime.
 */
import { createLogger } from '../lib/logger'
import { secureCleanup } from '../crypto/index'
import { withRetry } from '@memry/sync-client/retry'
import { encryptCrdtUpdate } from './crdt-encrypt'
import {
  isSnapshotNotCovered,
  pushCrdtFullUpdate,
  pushCrdtSnapshot,
  snapshotRefusalCursor
} from './http-client'
import { withAuthRetry, type AuthRetryDeps } from './auth-retry'
import type { SnapshotCoverage, SnapshotPushFn, SnapshotRefusal } from './crdt-provider'

const log = createLogger('CrdtSnapshotPush')

export interface CrdtSnapshotPushDeps {
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKey: () => Promise<Uint8Array | null>
  authRetryDeps: AuthRetryDeps
  /** `engine.hasUnmergedRemoteCrdtState`, asked again at send time. */
  hasUnmergedRemoteState: (noteId: string) => boolean
  /**
   * The server refused the snapshot: the stored one holds state this push does
   * not cover (#2299). `cursor` is the refusing snapshot's feed cursor. The
   * engine owes the note a pull and routes it to the update endpoint until its
   * feed passes that cursor or a pull moves its held snapshot revision, so the
   * refusal is never met again on the spot.
   */
  onNotCovered: (noteId: string, refusal: SnapshotRefusal) => void
  /** Told the sequence and revision of a snapshot the server stored (#2297). */
  onPushed: (noteId: string, pushed: { sequenceNum?: number; revision?: string }) => unknown
  /** Every failure, before it is rethrown: the runtime pauses on 401 and surfaces 413s. */
  onError: (noteId: string, err: unknown) => void
}

/**
 * The snapshot endpoint is the only destructive one. `storeSnapshot`
 * overwrites the note's single R2 blob and the prune then deletes
 * `crdt_updates` rows — every device's rows, not just this one's. That is
 * correct when this device really does contain what it claims, and a lie
 * whenever it does not: a merge pass that skipped a payload it could not
 * verify (#1489), and equally a pull that failed, was rate-limited, was
 * aborted, or has simply not run yet for a note the server has already told
 * us a peer wrote (#1503). The rows it deletes are by definition absent from
 * the snapshot replacing them, and then gone for every device.
 *
 * Every push funnels through this fn — the 30s `CrdtSnapshotScheduler`, the
 * oversized-update fallback, `close()`, `pushAllSnapshots`, `compactDoc` and
 * the push coordinator — so the routing decision belongs here.
 *
 * `coverage.coversThrough` (#2299) bounds the prune by feed cursor on a server
 * that understands it. It does not replace the routing:
 *   - a flagged note claims no cursor: its durable debt (#2297) records a
 *     lowest unmerged cursor for feed entries only, and a flag may also come
 *     from a speculative sweep that names no cursor at all;
 *   - a server that predates the field ignores it and prunes by watermark,
 *     exactly as before, and this device cannot tell it is talking to one.
 * So a note flagged at the encode (`coverage.unmerged`) or at send time still
 * goes to `/sync/crdt/updates`, which stores and broadcasts the same doc state
 * and prunes nothing. Failing closed instead is not available: a revoked
 * peer's key never returns, and a note held back forever strands this
 * device's own edits. The update route has a size ceiling the snapshot's R2
 * blob does not (`pushCrdtFullUpdate` throws past
 * MAX_CRDT_UPDATE_PAYLOAD_CHARS): a stall until the note merges, not a loss.
 */
export function createCrdtSnapshotPush(deps: CrdtSnapshotPushDeps): SnapshotPushFn {
  return async (noteId: string, state: Uint8Array, coverage: SnapshotCoverage) => {
    let token = await deps.getAccessToken()
    const vaultKey = await deps.getVaultKey()
    const signingSecretKey = await deps.getSigningKey()
    if (!token || !vaultKey || !signingSecretKey) {
      log.warn('Missing credentials for CRDT snapshot push', {
        noteId,
        authAvailable: !!token,
        hasVaultKey: !!vaultKey,
        hasSigningKey: !!signingSecretKey
      })
      if (vaultKey) secureCleanup(vaultKey)
      if (signingSecretKey) secureCleanup(signingSecretKey)
      throw new Error('Missing credentials for CRDT snapshot push')
    }

    try {
      const encrypted = encryptCrdtUpdate(state, vaultKey, noteId, signingSecretKey)
      const viaUpdates = coverage.unmerged || deps.hasUnmergedRemoteState(noteId)
      const pushed = await withRetry(
        () =>
          withAuthRetry(
            (authToken) =>
              viaUpdates
                ? pushCrdtFullUpdate(noteId, encrypted, authToken)
                : pushCrdtSnapshot(noteId, encrypted, authToken, coverage),
            token!,
            deps.authRetryDeps,
            (fresh) => {
              token = fresh
            }
          ),
        { maxRetries: 3, baseDelayMs: 2000 }
      )
      // The feed serves this device's own snapshot back (#2297); the
      // recorded revision lets it skip the download.
      if (!viaUpdates) {
        await deps.onPushed(
          noteId,
          (pushed.value ?? {}) as { sequenceNum?: number; revision?: string }
        )
      }
      // Distinct message per endpoint on purpose: log triage greps these
      // strings, and the notes someone is grepping for are exactly the ones
      // that did not take the snapshot route.
      log.debug(viaUpdates ? 'Pushed CRDT full state as an update' : 'Pushed CRDT snapshot', {
        noteId,
        size: state.byteLength,
        coversThrough: coverage.coversThrough
      })
    } catch (err) {
      if (isSnapshotNotCovered(err)) {
        log.info('Server holds a peer snapshot above coversThrough; owing the note a pull', {
          noteId,
          coversThrough: coverage.coversThrough
        })
        deps.onNotCovered(noteId, {
          cursor: snapshotRefusalCursor(err),
          claimed: coverage.coversThrough !== undefined,
          baseRevision: coverage.baseRevision
        })
      }
      deps.onError(noteId, err)
      throw err
    } finally {
      secureCleanup(vaultKey)
      secureCleanup(signingSecretKey)
    }
  }
}
