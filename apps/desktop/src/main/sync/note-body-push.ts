import { createLogger } from '../lib/logger'
import { secureCleanup } from '../crypto'
import { planCrdtUpdatePush } from '@memry/sync-client/crdt-payload'
import { sleep, withRetry } from '@memry/sync-client/retry'
import { withAuthRetry, type AuthRetryDeps } from './auth-retry'
import { encryptCrdtUpdate } from './crdt-encrypt'
import { postToServer } from './http-client'
import { crdtPushDelayMs } from './crdt-push-admission'
import {
  NoteBodyCredentialsMissingError,
  NoteBodyFlushDeferredError,
  type NoteBodyPushFn
} from './note-body-outbox'

const log = createLogger('SyncRuntime')

interface NoteBodyPushDeps {
  signal: AbortSignal
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getSigningKey: () => Promise<Uint8Array | null>
  authRetryDeps: AuthRetryDeps
  pushSnapshot: (noteId: string) => Promise<boolean>
  requestSnapshot: (noteId: string) => void
  onError: (noteId: string, error: unknown) => void
}

/** The runtime's incremental body sender; the outbox owns durable retries. */
export function createNoteBodyPush(deps: NoteBodyPushDeps): NoteBodyPushFn {
  return async (noteId, updates) => {
    const { signal } = deps
    let vaultKey: Uint8Array | null = null
    let signingKey: Uint8Array | null = null
    try {
      signal.throwIfAborted()
      let token = await deps.getAccessToken()
      signal.throwIfAborted()
      vaultKey = await deps.getVaultKey()
      signal.throwIfAborted()
      signingKey = await deps.getSigningKey()
      signal.throwIfAborted()
      if (!token || !vaultKey || !signingKey) {
        // Returning would acknowledge the durable rows. Hold them until refresh.
        throw new NoteBodyCredentialsMissingError('Missing credentials for CRDT update push')
      }
      const key = vaultKey
      const signer = signingKey
      const encrypted = updates.map((raw) =>
        Buffer.from(encryptCrdtUpdate(raw, key, noteId, signer)).toString('base64')
      )
      const { requests, oversized } = planCrdtUpdatePush(encrypted)
      for (const [index, batch] of requests.entries()) {
        if (index > 0) {
          const delayMs = crdtPushDelayMs()
          if (delayMs > 0) await sleep(delayMs, signal)
        }
        await withRetry(
          () =>
            withAuthRetry(
              (authToken) =>
                postToServer(
                  '/sync/crdt/updates',
                  { noteId, updates: batch },
                  authToken,
                  undefined,
                  undefined,
                  signal
                ),
              token!,
              deps.authRetryDeps,
              (fresh) => {
                token = fresh
              }
            ),
          { maxRetries: 3, baseDelayMs: 2000, retryOn429: false, signal }
        )
        signal.throwIfAborted()
      }
      if (oversized.length > 0) {
        // One update cannot fit D1. Its operations already live in the doc;
        // preserve the existing R2 snapshot fallback instead of dropping rows.
        log.warn('CRDT update too large for the incremental path, pushing a snapshot instead', {
          noteId,
          oversizedCount: oversized.length,
          largestChars: Math.max(...oversized.map((update) => update.length))
        })
        signal.throwIfAborted()
        const delayMs = crdtPushDelayMs()
        if (delayMs > 0) await sleep(delayMs, signal)
        const pushed = await deps.pushSnapshot(noteId)
        signal.throwIfAborted()
        if (!pushed) {
          log.error('CRDT snapshot fallback for an oversized update failed', { noteId })
          throw new NoteBodyFlushDeferredError('CRDT snapshot fallback failed')
        }
        return
      }
      deps.requestSnapshot(noteId)
    } catch (error) {
      if (!signal.aborted) deps.onError(noteId, error)
      throw error
    } finally {
      if (vaultKey) secureCleanup(vaultKey)
      if (signingKey) secureCleanup(signingKey)
    }
  }
}
