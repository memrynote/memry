import { createLogger } from '../lib/logger'
import { NetworkError, SyncServerError, getSyncVaultHeaders, type FetchFn } from './http-client'

const log = createLogger('AttachmentPresigner')

/**
 * How long a definitive "presign not available here" answer (old server → 404,
 * deployment without credentials → 501) stops us re-asking. Transient failures
 * (5xx/429/network) never poison this — they only fall back for one batch.
 */
const UNAVAILABLE_COOLDOWN_MS = 10 * 60_000

/** Clock-skew safety margin subtracted from the server's expiry claim. */
export const PRESIGN_EXPIRY_SAFETY_MS = 30_000

export interface AttachmentPresignerDeps {
  getSyncServerUrl: () => string
  fetchFn?: FetchFn
}

export interface PresignedUrlWindow {
  /** chunk hash → presigned GET URL */
  urls: Map<string, string>
  /** Epoch ms after which the URLs stop working (server expiry, skewed safe). */
  expiresAtMs: number
}

/**
 * Client side of direct-to-R2 downloads (#1836): fetches batches of presigned
 * chunk URLs from the Worker and tells the caller when to stay on the proxied
 * path instead.
 *
 * One instance per AttachmentSyncService so a definitively unavailable server
 * is remembered ACROSS transfers — a deployment that answered 501 must not be
 * probed again on every download for the next ten minutes.
 */
export class AttachmentPresigner {
  private unavailableUntil = 0

  constructor(private readonly deps: AttachmentPresignerDeps) {}

  get available(): boolean {
    return Date.now() >= this.unavailableUntil
  }

  /**
   * Fetch presigned GETs for `chunkHashes`. Resolves null whenever presigned
   * downloads are not usable right now — old server, unconfigured deployment,
   * transient server error, or offline — and the caller must use the proxied
   * path. Never throws.
   */
  async fetchBatch(
    token: string,
    chunkHashes: string[],
    opts?: { signal?: AbortSignal; isOnline?: () => boolean }
  ): Promise<PresignedUrlWindow | null> {
    if (!this.available || chunkHashes.length === 0) return null

    const url = `${this.deps.getSyncServerUrl()}/sync/attachments/presign-batch`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
    Object.assign(headers, await getSyncVaultHeaders())

    let response: Response
    try {
      const fetchImpl =
        this.deps.fetchFn ??
        ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ chunkHashes }),
        ...(opts?.signal ? { signal: opts.signal } : {})
      })
    } catch (err) {
      // Transport failure says nothing about availability; just fall back now.
      log.debug('presign batch unreachable, using proxied path', { err })
      return null
    }

    if (response.status === 404 || response.status === 501) {
      // Definitive: this server either predates the route or has no R2
      // credentials. Remember it so later transfers skip the probe entirely.
      this.unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS
      log.info('presigned transfers unavailable on this server; staying proxied', {
        status: response.status
      })
      return null
    }
    if (!response.ok) {
      // Transient (429/5xx): fall back for THIS batch, retry next window.
      log.warn('presign batch failed transiently, using proxied path', { status: response.status })
      return null
    }

    try {
      const body = (await response.json()) as {
        urls: Record<string, string>
        expiresAt: number
      }
      const expiresAtMs = Math.min(
        body.expiresAt * 1000 - PRESIGN_EXPIRY_SAFETY_MS,
        // Hard cap: even if the server claims a long TTL, treat URLs as stale
        // after ten minutes so a stuck clock cannot pin dead URLs forever.
        Date.now() + 10 * 60_000
      )
      return { urls: new Map(Object.entries(body.urls)), expiresAtMs }
    } catch (err) {
      log.warn('unparseable presign batch response, using proxied path', { err })
      return null
    }
  }
}

/**
 * Raw fetch of one chunk from its presigned URL — no auth headers, no vault
 * header: the URL's signature IS the authorization, and R2 would reject extra
 * signed-header surprises anyway (only `host` is signed).
 *
 * Throws NetworkError for transport failures and SyncServerError(403) for an
 * expired/rejected signature so the caller can distinguish refreshable URL
 * problems from ordinary transfer failures.
 */
export async function fetchChunkFromPresignedUrl(
  url: string,
  deps: { fetchFn?: FetchFn },
  init?: { signal?: AbortSignal }
): Promise<Uint8Array> {
  let response: Response
  try {
    const fetchImpl =
      deps.fetchFn ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))
    response = await fetchImpl(url, {
      method: 'GET',
      ...(init?.signal ? { signal: init.signal } : {})
    })
  } catch (err) {
    throw new NetworkError(`presigned chunk fetch failed: ${String(err)}`)
  }
  if (response.status === 403) {
    // Expired or wrong signature — refreshable by design, hence its own shape.
    throw new SyncServerError('Presigned URL rejected (expired?)', 403)
  }
  if (!response.ok) {
    throw new SyncServerError(`Presigned chunk fetch returned ${response.status}`, response.status)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Raw PUT of one ciphertext chunk to its presigned URL. Same no-auth contract
 * as the GET variant; any non-ok answer surfaces as SyncServerError so the
 * caller can fall back to the proxied chunk PUT for that chunk.
 */
export async function putChunkToPresignedUrl(
  url: string,
  data: Uint8Array,
  deps: { fetchFn?: FetchFn },
  init?: { signal?: AbortSignal }
): Promise<void> {
  let response: Response
  try {
    const fetchImpl =
      deps.fetchFn ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args))
    response = await fetchImpl(url, {
      method: 'PUT',
      body: Buffer.from(data),
      headers: { 'Content-Type': 'application/octet-stream' },
      ...(init?.signal ? { signal: init.signal } : {})
    })
  } catch (err) {
    throw new NetworkError(`presigned chunk put failed: ${String(err)}`)
  }
  if (!response.ok) {
    throw new SyncServerError(`Presigned chunk put returned ${response.status}`, response.status)
  }
}
