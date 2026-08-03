import { net } from 'electron'
import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { getMainI18n } from '../lib/main-i18n'
import { withRetry } from './retry'

// Declared to the server so it never sends this build an item type our
// RecordPullResponseSchema would reject — one unknown type fails the whole-page
// safeParse and silently drops the page.
const SYNC_TYPES_HEADER_VALUE = RECORD_SYNC_ITEM_TYPES.join(',')

function getSyncServerUrl(): string {
  const url = process.env.SYNC_SERVER_URL
  if (url) return url
  if (process.env.NODE_ENV === 'development') return 'http://localhost:8787'
  throw new Error('SYNC_SERVER_URL environment variable is not configured')
}

export type FetchFn = typeof globalThis.fetch

export class SyncServerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly serverError?: string
  ) {
    super(message)
    this.name = 'SyncServerError'
  }
}

/**
 * One file is over the plan's per-file limit. Raised by the local preflight
 * before a file is read/encrypted; mirrors the server's STORAGE_FILE_TOO_LARGE.
 * Lives here with the other sync error types so `sync-errors` can classify it
 * without importing the attachment service (and with it, electron + crypto).
 */
export class AttachmentTooLargeError extends Error {
  constructor(
    message: string,
    public readonly fileSize: number,
    public readonly maxFileSize: number
  ) {
    super(message)
    this.name = 'AttachmentTooLargeError'
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

const MAX_RETRY_AFTER_SECONDS = 300

export class RateLimitError extends SyncServerError {
  public readonly retryAfterMs: number

  constructor(public readonly retryAfter?: number) {
    super('Too many requests. Please try again later.', 429)
    this.name = 'RateLimitError'
    this.retryAfterMs = Math.min(retryAfter ?? 60, MAX_RETRY_AFTER_SECONDS) * 1000
  }
}

export function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds
  const date = new Date(header)
  if (!Number.isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now()
    return Math.max(0, Math.ceil(deltaMs / 1000))
  }
  return undefined
}

export async function getSyncVaultHeaders(): Promise<Record<string, string>> {
  try {
    const [{ getDatabase }, { getOrCreateVaultUuid }] = await Promise.all([
      import('../database'),
      import('../agent/storage/vault-id')
    ])
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
  timeoutMs: number = SYNC_REQUEST_TIMEOUT_MS
): Promise<T> => {
  const url = `${getSyncServerUrl()}${path}`
  const fetchImpl = fetchFn ?? ((...args: Parameters<typeof net.fetch>) => net.fetch(...args))

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
    headers['X-Memry-Sync-Types'] = SYNC_TYPES_HEADER_VALUE
    Object.assign(headers, await getSyncVaultHeaders())
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
  fetchFn?: FetchFn
): Promise<T> => {
  return syncFetch<T>('POST', path, body, token, fetchFn)
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

export async function fetchCrdtSnapshot(
  noteId: string,
  token: string
): Promise<{ snapshot: Uint8Array; sequenceNum: number; signerDeviceId: string } | null> {
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

  return { snapshot: bytes, sequenceNum: result.sequenceNum, signerDeviceId: result.signerDeviceId }
}
