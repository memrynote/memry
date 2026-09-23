import { IcsFeedError } from './ics-feed'

const FETCH_TIMEOUT_MS = 30_000
const MAX_FEED_BYTES = 20 * 1024 * 1024

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

/**
 * GET a feed, conditionally when validators from the last good response are
 * known, so an unchanged calendar costs one 304 instead of a re-download.
 */
export async function fetchIcsFeed(
  url: string,
  validators: IcsValidators | null,
  fetchImpl: FetchLike = fetch
): Promise<IcsFetchResult> {
  const headers: Record<string, string> = { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' }
  if (validators?.etag) headers['If-None-Match'] = validators.etag
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new IcsFeedError('timeout')
    }
    throw new IcsFeedError('unreachable', error instanceof Error ? error.message : undefined)
  }

  if (response.status === 304) return { status: 'not_modified' }
  if (!response.ok) throw statusError(response.status)

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_FEED_BYTES) throw new IcsFeedError('too_large')

  const body = await response.text()
  if (body.length > MAX_FEED_BYTES) throw new IcsFeedError('too_large')

  return {
    status: 'ok',
    body,
    validators: {
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified')
    }
  }
}
