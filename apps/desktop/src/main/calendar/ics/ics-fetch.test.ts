import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeIcsUrl } from './ics-feed'
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

/**
 * Feeds that misbehave on purpose, served by a real HTTP server so the
 * platform fetch's own chunking and redirect handling are what is tested.
 */
describe('fetchIcsFeed against a hostile feed server', () => {
  const CHUNK = Buffer.alloc(64 * 1024, 'A')
  let server: Server
  let origin: string
  let chunksSent = 0
  let requests: string[] = []

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
    '/endless.ics': (_req, res) => {
      // Chunked, no Content-Length, never ends on its own: only a client that
      // enforces the cap while streaming gets out of this.
      res.writeHead(200, { 'content-type': 'text/calendar' })
      const pump = (): void => {
        while (!res.destroyed) {
          chunksSent += 1
          if (!res.write(CHUNK)) {
            res.once('drain', pump)
            return
          }
        }
      }
      pump()
    },
    '/loop.ics': (_req, res) => {
      res.writeHead(302, { location: '/loop.ics' })
      res.end()
    },
    '/to-file.ics': (_req, res) => {
      res.writeHead(301, { location: 'file:///etc/passwd' })
      res.end()
    },
    '/to-javascript.ics': (_req, res) => {
      res.writeHead(307, { location: 'javascript:alert(1)' })
      res.end()
    },
    '/moved.ics': (_req, res) => {
      res.writeHead(301, { location: '/hop.ics' })
      res.end()
    },
    '/hop.ics': (_req, res) => {
      res.writeHead(308, { location: '/calendar.ics' })
      res.end()
    },
    '/calendar.ics': (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' })
      res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    }
  }
  const routeByPath = new Map(Object.entries(routes))

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '')
      const route = routeByPath.get(req.url ?? '')
      if (route) {
        route(req, res)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function codeFor(path: string): Promise<string> {
    try {
      await fetchIcsFeed(`${origin}${path}`, null)
      return 'resolved'
    } catch (error) {
      return (error as { code?: string }).code ?? 'no-code'
    }
  }

  it('stops reading a chunked body at the cap instead of downloading all of it', async () => {
    chunksSent = 0
    expect(await codeFor('/endless.ics')).toBe('too_large')
    // 20 MB is 320 chunks of 64 KB; socket buffers let the server get a little
    // ahead, but nowhere near an unbounded download.
    expect(chunksSent).toBeLessThan(2_000)
  })

  it('gives up on a redirect loop after a few hops', async () => {
    requests = []
    expect(await codeFor('/loop.ics')).toBe('too_many_redirects')
    expect(requests).toHaveLength(6)
  })

  it('refuses a redirect to anything but http(s)', async () => {
    expect(await codeFor('/to-file.ics')).toBe('unsupported_redirect')
    expect(await codeFor('/to-javascript.ics')).toBe('unsupported_redirect')
  })

  it('follows a short redirect chain and keeps the conditional headers on every hop', async () => {
    const first = await fetchIcsFeed(`${origin}/moved.ics`, null)
    expect(first).toEqual({
      status: 'ok',
      body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      validators: { etag: '"v1"', lastModified: null }
    })

    const second = await fetchIcsFeed(`${origin}/moved.ics`, { etag: '"v1"', lastModified: null })
    expect(second).toEqual({ status: 'not_modified' })
  })

  it('allows loopback and private-network feeds (a home Radicale or NAS)', async () => {
    // Pinned decision (#1397): no SSRF filter. The URL always comes from the
    // user's own vault, and LAN calendars are a real use.
    for (const lan of [
      'http://127.0.0.1:5232/user/calendar.ics',
      'http://localhost:5232/user/calendar.ics',
      'http://192.168.1.20/remote.php/dav/public-calendars/abc?export',
      'http://10.0.0.5/cal.ics',
      'http://[::1]:8080/cal.ics',
      'webcal://nas.local/cal.ics'
    ]) {
      expect(normalizeIcsUrl(lan)).not.toBeNull()
    }
    const result = await fetchIcsFeed(`${origin}/calendar.ics`, null)
    expect(result.status).toBe('ok')
  })
})
