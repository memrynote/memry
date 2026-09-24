import { IcsFeedError } from './ics-feed'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FEED_BYTES = 20 * 1024 * 1024
// Feed hosts redirect once or twice (http → https, a CDN, a renamed path).
// Anything past a handful is a loop or a hop chain, not a calendar.
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface IcsValidators {
  etag: string | null
  lastModified: string | null
}

export type IcsFetchResult =
  { status: 'not_modified' } | { status: 'ok'; body: string; validators: IcsValidators }

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function statusError(status: number): IcsFeedError {
  if (status === 404 || status === 410) return new IcsFeedError('not_found', `HTTP ${status}`)
  if (status === 401 || status === 403) return new IcsFeedError('unauthorized', `HTTP ${status}`)
  return new IcsFeedError('http_error', `HTTP ${status}`)
}

function transportError(error: unknown): IcsFeedError {
  if (error instanceof IcsFeedError) return error
  if (error instanceof Error && error.name === 'TimeoutError') return new IcsFeedError('timeout')
  return new IcsFeedError('unreachable', error instanceof Error ? error.message : undefined)
}

/** Where a redirect points, or an error when it points somewhere a feed cannot live. */
function redirectTarget(response: Response, currentUrl: string): string {
  const location = response.headers.get('location')
  if (!location) throw new IcsFeedError('http_error', `HTTP ${response.status} without Location`)
  let next: URL
  try {
    next = new URL(location, currentUrl)
  } catch {
    throw new IcsFeedError('unsupported_redirect', 'Unparseable Location')
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') {
    throw new IcsFeedError('unsupported_redirect', `Redirect to ${next.protocol}`)
  }
  return next.toString()
}

/**
 * Read the body up to the cap. `Content-Length` is only a hint: a chunked
 * response has none and a hostile one can understate it, so the cap is
 * enforced on the bytes as they arrive and the stream is cancelled the
 * moment it is crossed, before the rest is downloaded.
 */
async function readCappedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new IcsFeedError('too_large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * GET a feed, conditionally when validators from the last good response are
 * known, so an unchanged calendar costs one 304 instead of a re-download.
 *
 * Private and loopback addresses are allowed on purpose. A source row only
 * comes from the user's own vault (they pasted the link, or synced it from
 * another of their devices), and a calendar on the home network (Radicale,
 * Nextcloud, a NAS) is a real use for this audience. There is no third party
 * who could aim this fetch at the LAN, so blocking it would only break those
 * users. Redirects are followed by hand so each hop is checked: at most
 * MAX_REDIRECTS, and only to http(s).
 */
export async function fetchIcsFeed(
  url: string,
  validators: IcsValidators | null,
  fetchImpl: FetchLike = fetch
): Promise<IcsFetchResult> {
  const headers: Record<string, string> = { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' }
  if (validators?.etag) headers['If-None-Match'] = validators.etag
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified

  // One deadline for the whole exchange: every hop and the body.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let currentUrl = url
  let response: Response
  for (let redirects = 0; ; redirects += 1) {
    try {
      response = await fetchImpl(currentUrl, { headers, redirect: 'manual', signal })
    } catch (error) {
      throw transportError(error)
    }
    if (!REDIRECT_STATUSES.has(response.status)) break
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= MAX_REDIRECTS) throw new IcsFeedError('too_many_redirects')
    currentUrl = redirectTarget(response, currentUrl)
  }

  if (response.status === 304) return { status: 'not_modified' }
  if (!response.ok) throw statusError(response.status)

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_FEED_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new IcsFeedError('too_large')
  }

  let body: string
  try {
    body = await readCappedBody(response)
  } catch (error) {
    throw transportError(error)
  }

  return {
    status: 'ok',
    body,
    validators: {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified')
    }
  }
}
