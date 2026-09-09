import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchRemoteImage } from '../remote'

const URL_UNDER_TEST = 'https://example.com/favicon.png'

function reply(options: {
  status?: number
  headers?: Record<string, string>
  body?: Uint8Array
}): unknown {
  const headers = new Map(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const body = options.body ?? new Uint8Array()
  const status = options.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
}

function stubFetch(impl: (url: string, init: { signal: AbortSignal }) => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchRemoteImage', () => {
  it('returns the bytes with the content-type parameters stripped', async () => {
    stubFetch(async () =>
      reply({
        headers: { 'Content-Type': 'image/PNG; charset=binary' },
        body: new Uint8Array([1, 2, 3])
      })
    )

    expect(await fetchRemoteImage(URL_UNDER_TEST)).toEqual({
      status: 'ready',
      b64: 'AQID',
      mime: 'image/png'
    })
  })

  it('reports missing on a 404', async () => {
    stubFetch(async () => reply({ status: 404 }))
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('missing')
  })

  it('reports pending on a 500', async () => {
    stubFetch(async () => reply({ status: 500 }))
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('pending')
  })

  it('reports pending on a 429', async () => {
    stubFetch(async () => reply({ status: 429 }))
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('pending')
  })

  it('reports pending when the request throws', async () => {
    stubFetch(async () => {
      throw new Error('Network request failed')
    })
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('pending')
  })

  it('reports missing for a non-image content-type', async () => {
    stubFetch(async () =>
      reply({ headers: { 'content-type': 'text/html' }, body: new Uint8Array([1]) })
    )
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('missing')
  })

  it('reports missing when there is no content-type at all', async () => {
    stubFetch(async () => reply({ body: new Uint8Array([1]) }))
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('missing')
  })

  it('reports missing on an oversize content-length', async () => {
    stubFetch(async () =>
      reply({
        headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
        body: new Uint8Array([1])
      })
    )
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('missing')
  })

  it('reports missing on an oversize body with no content-length', async () => {
    stubFetch(async () =>
      reply({
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(6 * 1024 * 1024)
      })
    )
    expect((await fetchRemoteImage(URL_UNDER_TEST)).status).toBe('missing')
  })

  it('reports pending when the request times out', async () => {
    vi.useFakeTimers()
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('Aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
    )

    const answer = fetchRemoteImage(URL_UNDER_TEST)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await answer).status).toBe('pending')
  })
})
