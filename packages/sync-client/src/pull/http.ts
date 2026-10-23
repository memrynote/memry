import { RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import type { SyncHttpClient } from '../adapters/http-client.ts'
import {
  NetworkError,
  RateLimitError,
  SyncServerError,
  parseRetryAfterHeader
} from '../http-errors.ts'
import { CLIENT_HEADER } from './client-header.ts'

/**
 * JSON transport over the SyncHttpClient seam — the seam-based twin of
 * desktop's `syncFetch`. The engine owns every header here (the adapter
 * contract forbids adapters from inventing them): Authorization, the vault id,
 * the sync-type negotiation list, and `x-memry-client` (T046).
 */

export const SYNC_TYPES_HEADER = 'X-Memry-Sync-Types'
export const VAULT_ID_HEADER = 'X-Memry-Vault-Id'

export interface SeamHttpContext {
  http: SyncHttpClient
  accessToken: () => string
  vaultId?: string
  /** `<platform>/<semver>[+build]` — attached to every request. */
  clientHeaderValue: string
  signal?: AbortSignal
  /** Per-request ceiling; defaults to 60s (desktop's SYNC_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number
}

/**
 * Every request gets a hard timeout. Without one, a single stalled socket
 * (iOS freezes sockets when the app backgrounds mid-request) never resolves,
 * which latches the engine's in-flight-sync guard and jams the exclusive
 * queue forever — observed on the simulator as a permanent silent hang.
 * Implemented with AbortController (Hermes has no AbortSignal.timeout).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

function withTimeoutSignal(
  outer: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('sync request timed out')), timeoutMs)
  const onOuterAbort = () => controller.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }
}

interface JsonRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

const decoder = new TextDecoder()

export async function seamJsonRequest<T>(ctx: SeamHttpContext, req: JsonRequest): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${ctx.accessToken()}`,
    [SYNC_TYPES_HEADER]: RECORD_SYNC_ITEM_TYPES.join(','),
    [CLIENT_HEADER]: ctx.clientHeaderValue
  }
  if (ctx.vaultId) headers[VAULT_ID_HEADER] = ctx.vaultId

  const timeout = withTimeoutSignal(ctx.signal, ctx.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await ctx.http.request({
      method: req.method,
      path: req.path,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: timeout.signal
    })
  } catch (err) {
    // An outer-caller abort stays an abort; a timeout becomes a NetworkError
    // so withRetry treats it like any other transient transport failure.
    if (err instanceof Error && err.name === 'AbortError' && ctx.signal?.aborted) throw err
    throw new NetworkError(err instanceof Error ? err.message : String(err))
  } finally {
    timeout.cancel()
  }

  if (response.status === 429) {
    throw new RateLimitError(parseRetryAfterHeader(response.headers['retry-after'] ?? null))
  }

  const text = response.body.length > 0 ? decoder.decode(response.body) : ''

  if (response.status < 200 || response.status >= 300) {
    let code: string | undefined
    let message = `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { error?: string | { code?: string; message?: string } }
      if (typeof parsed.error === 'string') {
        message = parsed.error
      } else if (parsed.error) {
        code = parsed.error.code
        message = parsed.error.message ?? message
      }
    } catch {
      // non-JSON error body; keep defaults
    }
    throw new SyncServerError(message, response.status, code)
  }

  return (text ? JSON.parse(text) : {}) as T
}
