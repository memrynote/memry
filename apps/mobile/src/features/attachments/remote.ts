import { bytesToBase64 } from '@/lib/base64'
import { createLogger } from '@/lib/logger'
import type { ResolvedAsset } from './resolve'

const log = createLogger('RemoteImage')

/**
 * Fetch a remote image on the host's behalf (#2097).
 *
 * The editor document's CSP is `img-src data: blob:; connect-src 'none'`, so the
 * guest can neither load nor request a remote favicon or bookmark thumbnail.
 * RN fetches the bytes and answers the existing `asset-req` round trip with a
 * data URI, which keeps the CSP exactly as narrow as it is.
 *
 * `missing` versus `pending` is the whole design of the return: `missing` is a
 * PERMANENT verdict that stops the guest re-asking, so it is reserved for
 * answers that cannot change (a 404, a page that is not an image, something too
 * big to inline). Anything transient — a timeout, a dropped connection, a 5xx,
 * a rate limit — reports `pending` and is re-asked on the guest's backoff.
 */

const TIMEOUT_MS = 10_000
const MAX_BYTES = 5 * 1024 * 1024
/** Transient status codes; every other non-2xx is a settled "no". */
const RETRYABLE_STATUS = new Set([408, 429])

export async function fetchRemoteImage(url: string): Promise<ResolvedAsset> {
  // Never the full URL: it is note content, and a query string can carry a
  // token. 128 chars is the same budget `open-external` logging uses.
  const shortUrl = url.slice(0, 128)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(url, { signal: controller.signal })

    if (!response.ok) {
      const transient = response.status >= 500 || RETRYABLE_STATUS.has(response.status)
      log.warn('Remote image request failed', { url: shortUrl, status: response.status })
      return { status: transient ? 'pending' : 'missing' }
    }

    const contentType = response.headers.get('content-type')
    const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
    if (!mime.startsWith('image/')) {
      log.warn('Remote image is not an image', { url: shortUrl, contentType: mime })
      return { status: 'missing' }
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      log.warn('Remote image is too large to inline', { url: shortUrl, bytes: declaredLength })
      return { status: 'missing' }
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    // Re-checked after decoding: `Content-Length` is the server's claim, and it
    // is absent under chunked transfer entirely.
    if (bytes.length > MAX_BYTES) {
      log.warn('Remote image is too large to inline', { url: shortUrl, bytes: bytes.length })
      return { status: 'missing' }
    }

    return { status: 'ready', b64: bytesToBase64(bytes), mime }
  } catch (err: unknown) {
    log.warn('Remote image fetch threw', {
      url: shortUrl,
      error: err instanceof Error ? err.message : String(err)
    })
    return { status: 'pending' }
  } finally {
    clearTimeout(timer)
  }
}
