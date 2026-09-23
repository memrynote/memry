import { describe, expect, it } from 'vitest'
import { fetchIcsFeed, type FetchLike } from './ics-fetch'

const URL = 'https://calendar.example.com/feed.ics'

function respondWith(response: Response | Error): FetchLike {
  return async () => {
    if (response instanceof Error) throw response
    return response
  }
}

async function failureCode(fetchImpl: FetchLike): Promise<string> {
  try {
    await fetchIcsFeed(URL, null, fetchImpl)
    return 'resolved'
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
}

describe('fetchIcsFeed', () => {
  it('returns the body with the validators the next request will send', async () => {
    const result = await fetchIcsFeed(
      URL,
      null,
      respondWith(
        new Response('BEGIN:VCALENDAR', {
          status: 200,
          headers: { etag: '"v7"', 'last-modified': 'Tue, 05 May 2026 10:00:00 GMT' }
        })
      )
    )

    expect(result).toEqual({
      status: 'ok',
      body: 'BEGIN:VCALENDAR',
      validators: { etag: '"v7"', lastModified: 'Tue, 05 May 2026 10:00:00 GMT' }
    })
  })

  it('sends both validators and reports an unchanged feed', async () => {
    let sent: Record<string, string> = {}
    const result = await fetchIcsFeed(
      URL,
      { etag: '"v7"', lastModified: 'Tue, 05 May 2026 10:00:00 GMT' },
      async (_url, init) => {
        sent = init.headers as Record<string, string>
        return new Response(null, { status: 304 })
      }
    )

    expect(result).toEqual({ status: 'not_modified' })
    expect(sent['If-None-Match']).toBe('"v7"')
    expect(sent['If-Modified-Since']).toBe('Tue, 05 May 2026 10:00:00 GMT')
  })

  it('maps each way a feed can fail to the code the user sees', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'

    expect(await failureCode(respondWith(timeout))).toBe('timeout')
    expect(await failureCode(respondWith(new TypeError('fetch failed')))).toBe('unreachable')
    expect(await failureCode(respondWith(new Response('', { status: 410 })))).toBe('not_found')
    expect(await failureCode(respondWith(new Response('', { status: 403 })))).toBe('unauthorized')
    expect(await failureCode(respondWith(new Response('', { status: 503 })))).toBe('http_error')
    expect(
      await failureCode(
        respondWith(
          new Response('', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } })
        )
      )
    ).toBe('too_large')
  })
})
