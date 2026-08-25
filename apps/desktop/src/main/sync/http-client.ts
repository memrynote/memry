import { net } from 'electron'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { getMainI18n } from '../lib/main-i18n'
import { resolveSyncServerUrl } from '@memry/sync-client/sync-server-url'
import { withRetry } from '@memry/sync-client/retry'
import { MAX_CRDT_UPDATE_PAYLOAD_CHARS } from '@memry/sync-client/crdt-payload'
import { getBootstrapTokenHeaders } from './bootstrap-session-state'

// Declared to the server so it never sends this build an item type our
// RecordPullResponseSchema would reject — one unknown type fails the whole-page
// safeParse and silently drops the page.
const SYNC_TYPES_HEADER_VALUE = RECORD_SYNC_ITEM_TYPES.join(',')

export type FetchFn = typeof globalThis.fetch

export {
  SyncServerError,
  AttachmentTooLargeError,
  NetworkError,
  RateLimitError,
  parseRetryAfterHeader
} from '@memry/sync-client/http-errors'
import {
  SyncServerError,
  NetworkError,
  RateLimitError,
  parseRetryAfterHeader
} from '@memry/sync-client/http-errors'

export async function getSyncVaultHeaders(): Promise<Record<string, string>> {
  try {
    // The imports stay inside the call: hoisting them to module scope would
    // pull ../database in at import time, which is exactly the eagerness the
    // lazy resolution in this file exists to avoid. They resolve from the
    // module registry after the first call.
    const [{ getDatabase }, { getOrCreateVaultUuid }] = await Promise.all([
      import('../database'),
      import('../agent/storage/vault-id')
    ])
    // The SQLite read this used to repeat per authenticated request is now
    // cached inside getOrCreateVaultUuid, keyed on the same DataDb handle —
    // one mechanism for all eleven call sites, one invalidation hook
    // (resetVaultUuidCache) instead of a second cache to keep in step here.
    const vaultId = getOrCreateVaultUuid(getDatabase())
    return vaultId ? { 'X-Memry-Vault-Id': vaultId } : {}
  } catch {
    return {}
  }
}

interface ServerErrorResponse {
  error?: string | { code: string; message: string }
  message?: string
}

// A socket that black-holes (suspend/resume, NAT teardown) would otherwise
// keep this request pending forever — and with it the sync lock, which
// silences every future periodic pull until the app restarts. The timeout is
// per attempt; withRetry owns the retry budget on top of it.
export const SYNC_REQUEST_TIMEOUT_MS = 60_000

export const syncFetch = async <T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
  token?: string,
  fetchFn?: FetchFn,
  timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS,
  /** Extra headers merged last (e.g. a bootstrap token already captured
   * before local session teardown — see bootstrap-session.ts close). */
  extraHeaders?: Record<string, string>
): Promise<T> => {
  // Resolved per call, never hoisted to a module-level const: dotenv runs in
  // index.ts *after* this module is imported, so capturing at import time
  // freezes the wrong value (see sync-server-url.ts). resolveSyncServerUrl()
  // preserves that laziness and additionally strips a trailing slash, which
  // this file used to pass through verbatim — `${url}/sync/...` against a
  // slash-terminated env yields `//sync/...`, a different route to Cloudflare
  // Workers, so every sync request 404'd.
  const url = `${resolveSyncServerUrl()}${path}`
  const fetchImpl = fetchFn ?? ((...args: Parameters<typeof net.fetch>) => net.fetch(...args))

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    headers['X-Memry-Sync-Types'] = SYNC_TYPES_HEADER_VALUE
    Object.assign(headers, await getSyncVaultHeaders())
    // Bootstrap elevation (#1837): an active fresh-device session rides along
    // on every authenticated request. Old servers ignore the unknown header;
    // no session → no header → byte-for-byte today's request.
    Object.assign(headers, getBootstrapTokenHeaders())
  }
  if (extraHeaders) {
    Object.assign(headers, extraHeaders)
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new NetworkError(getMainI18n().t('errors:sync.requestTimedOut'))
    }
    throw new NetworkError(getMainI18n().t('errors:sync.serverUnreachable'))
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfterHeader(response.headers.get('Retry-After'))
    throw new RateLimitError(retryAfter)
  }

  let responseBody: unknown
  try {
    responseBody = await response.json()
  } catch {
    if (!response.ok) {
      throw new SyncServerError(`Server returned ${response.status}`, response.status)
    }
    throw new SyncServerError('Invalid response body', response.status)
  }

  if (!response.ok) {
    const errorBody = responseBody as ServerErrorResponse
    const errorCode = typeof errorBody?.error === 'object' ? errorBody.error.code : undefined
    const message =
      (typeof errorBody?.error === 'string' ? errorBody.error : errorBody?.error?.message) ||
      errorBody?.message ||
      `Server error (${response.status})`
    const serverError = errorCode ? `${errorCode}: ${message}` : message
    throw new SyncServerError(message, response.status, serverError)
  }

  return responseBody as T
}

export const postToServer = async <T>(
  path: string,
  body?: unknown,
  token?: string,
  fetchFn?: FetchFn,
  extraHeaders?: Record<string, string>
): Promise<T> => {
  return syncFetch<T>('POST', path, body, token, fetchFn, SYNC_REQUEST_TIMEOUT_MS, extraHeaders)
}

export const getFromServer = async <T>(
  path: string,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('GET', path, undefined, token, fetchFn)
}

export const deleteFromServer = async <T>(
  path: string,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('DELETE', path, undefined, token, fetchFn)
}

export const patchToServer = async <T>(
  path: string,
  body?: unknown,
  token?: string,
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('PATCH', path, body, token, fetchFn)
}

export interface CrdtSnapshotResponse {
  snapshot: string | null
  sequenceNum: number
  signerDeviceId: string | null
  /**
   * Opaque token identifying which snapshot blob this is, so a later batch pull
   * can say "still that one" and the client can skip re-downloading it.
   *
   * Optional because a server that predates the token omits the key entirely,
   * and these responses are read through an unvalidated cast — an absent key is
   * `undefined` at runtime, which must read as "unknown", never as a match.
   */
  revision?: string | null
}

/**
 * What the batch pull says about the server's snapshot for one note, so a
 * client can decide whether to download it without downloading it.
 *
 * `sequenceNum` is the server's prune watermark for the note:
 * `pruneUpdatesBeforeSnapshot` deletes every update at or below it, so asking
 * for a range starting under it is answered with silence, not an error.
 */
export interface CrdtSnapshotMeta {
  sequenceNum: number
  revision: string
  signerDeviceId: string
}

export interface CrdtBatchPullResponse {
  notes: Record<
    string,
    {
      updates: Array<{
        sequenceNum: number
        data: string
        signerDeviceId: string
        createdAt: number
      }>
      hasMore: boolean
    }
  >
  /**
   * Present on every response from a server that supports it, which is what
   * lets a client tell "this server is old" (key absent) from "this server has
   * no snapshot for that note" (key present, note absent from the map).
   *
   * Optional, and deliberately so: `postToServer` is a TypeScript cast with no
   * runtime schema validation, so against an old server this is `undefined` at
   * runtime however the type reads. Every consumer must default to fetching.
   */
  snapshotMeta?: Record<string, CrdtSnapshotMeta>
}

export async function pushCrdtSnapshot(
  noteId: string,
  encryptedSnapshot: Uint8Array,
  token: string
): Promise<{ sequenceNum: number }> {
  const b64 = Buffer.from(encryptedSnapshot).toString('base64')
  return postToServer<{ sequenceNum: number }>(
    '/sync/crdt/snapshot',
    { noteId, snapshot: b64 },
    token
  )
}

/**
 * Push a full document state to the INCREMENTAL endpoint.
 *
 * The same bytes `pushCrdtSnapshot` would send, with a different consequence.
 * `/sync/crdt/snapshot` overwrites the note's one snapshot blob and then runs
 * `pruneUpdatesBeforeSnapshot`, which deletes every `crdt_updates` row at or
 * below the stored watermark. `/sync/crdt/updates` appends and prunes nothing.
 *
 * That difference is the whole point: a device that merged *around* server
 * state it could not verify must not assert "I contain everything up to here",
 * because the payload it skipped is by definition absent from the snapshot
 * replacing it. See the endpoint choice in `runtime.ts`.
 *
 * The ceiling is the incremental path's rather than the snapshot's — the server
 * stores each update as a D1 blob, not an R2 object.
 */
export async function pushCrdtFullUpdate(
  noteId: string,
  encryptedState: Uint8Array,
  token: string
): Promise<unknown> {
  const b64 = Buffer.from(encryptedState).toString('base64')
  if (b64.length > MAX_CRDT_UPDATE_PAYLOAD_CHARS) {
    throw new Error(`CRDT state too large for the non-pruning push path: ${b64.length}`)
  }
  return postToServer('/sync/crdt/updates', { noteId, updates: [b64] }, token)
}

export async function fetchCrdtSnapshot(
  noteId: string,
  token: string
): Promise<{
  snapshot: Uint8Array
  sequenceNum: number
  signerDeviceId: string
  revision: string | null
} | null> {
  const { value: result } = await withRetry(
    () =>
      getFromServer<CrdtSnapshotResponse>(
        `/sync/crdt/snapshot/${encodeURIComponent(noteId)}`,
        token
      ),
    // Snapshot baselines are fetched per note inside a serial loop, so honouring
    // Retry-After here would stall every remaining note. The sync pass cadence
    // is the retry.
    { maxRetries: 3, baseDelayMs: 2000, retryOn429: false }
  )

  if (!result.snapshot || !result.signerDeviceId) return null

  const bytes = new Uint8Array(Buffer.from(result.snapshot, 'base64'))

  return {
    snapshot: bytes,
    sequenceNum: result.sequenceNum,
    signerDeviceId: result.signerDeviceId,
    // `null` for a server that does not send one. Normalising the absent key to
    // `null` here keeps "no token" a single value at the one place that decides
    // whether to remember it.
    revision: result.revision ?? null
  }
}
