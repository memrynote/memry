import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EXPORT_IDS_BATCH_SIZE,
  ReadwiseError,
  exportBooks,
  exportPages,
  readwiseGet,
  verifyToken,
  type ReadwiseBook
} from './client'

const TOKEN = 'rw-secret-token'

function book(id: number): Record<string, unknown> {
  return { user_book_id: id, title: `Book ${id}`, highlights: [{ id: id * 10, text: 'h' }] }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

function page(ids: number[], next: string | null): Response {
  return jsonResponse({ count: ids.length, nextPageCursor: next, results: ids.map(book) })
}

async function collect(gen: AsyncGenerator<ReadwiseBook[]>): Promise<number[][]> {
  const pages: number[][] = []
  for await (const books of gen) pages.push(books.map((b) => b.user_book_id))
  return pages
}

let fetchMock: ReturnType<typeof vi.fn>

function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map((call) => new URL(call[0] as string))
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('verifyToken', () => {
  it('sends the Token header and accepts 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(verifyToken(TOKEN)).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://readwise.io/api/v2/auth/')
    expect(init.headers).toEqual({ Authorization: `Token ${TOKEN}` })
    expect(init.method).toBe('GET')
  })

  it.each([401, 403])('maps %i to invalid-token without leaking the token', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }))
    const error = await verifyToken(TOKEN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ReadwiseError)
    expect((error as ReadwiseError).code).toBe('invalid-token')
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('maps a 5xx to server and a thrown fetch to network', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }))
    await expect(verifyToken(TOKEN)).rejects.toMatchObject({ code: 'server', status: 502 })
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(verifyToken(TOKEN)).rejects.toMatchObject({ code: 'network' })
  })
})

describe('exportPages', () => {
  it('follows nextPageCursor across three pages and sends the filters', async () => {
    fetchMock
      .mockResolvedValueOnce(page([1, 2], 'c2'))
      .mockResolvedValueOnce(page([3], 'c3'))
      .mockResolvedValueOnce(page([4], null))

    const pages = await collect(
      exportPages({ token: TOKEN, updatedAfter: '2026-10-01T00:00:00Z', includeDeleted: true })
    )

    expect(pages).toEqual([[1, 2], [3], [4]])
    const urls = requestedUrls()
    expect(urls.map((u) => u.searchParams.get('pageCursor'))).toEqual([null, 'c2', 'c3'])
    for (const url of urls) {
      expect(url.pathname).toBe('/api/v2/export/')
      expect(url.searchParams.get('updatedAfter')).toBe('2026-10-01T00:00:00Z')
      expect(url.searchParams.get('includeDeleted')).toBe('true')
    }
  })

  it('omits updatedAfter and includeDeleted when not asked for', async () => {
    fetchMock.mockResolvedValue(page([1], null))
    await collect(exportPages({ token: TOKEN, includeDeleted: false }))
    const url = requestedUrls()[0]
    expect(url.searchParams.has('updatedAfter')).toBe(false)
    expect(url.searchParams.has('includeDeleted')).toBe(false)
  })

  it('stops on a repeated cursor instead of looping forever', async () => {
    fetchMock.mockImplementation(async () => page([1], 'same'))
    await expect(
      collect(exportPages({ token: TOKEN, includeDeleted: false }))
    ).rejects.toMatchObject({ code: 'server' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a page in an unknown shape as a server error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: 'nope' }))
    await expect(
      collect(exportPages({ token: TOKEN, includeDeleted: false }))
    ).rejects.toMatchObject({ code: 'server' })
  })

  it('aborts in the middle of a page and requests nothing more', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- rejecting with the abort reason or a non-Error value is what this test simulates
              reject(init.signal?.reason)
            },
            { once: true }
          )
        })
    )
    const pending = collect(
      exportPages({ token: TOKEN, includeDeleted: false, signal: controller.signal })
    )
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops between pages when aborted after the first page', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(page([1], 'c2'))
    const seen: number[][] = []
    const run = (async () => {
      for await (const books of exportPages({
        token: TOKEN,
        includeDeleted: false,
        signal: controller.signal
      })) {
        seen.push(books.map((b) => b.user_book_id))
        controller.abort()
      }
    })()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen).toEqual([[1]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('exportBooks', () => {
  it('batches ids, dedupes them, and paginates inside a batch', async () => {
    const ids = Array.from({ length: EXPORT_IDS_BATCH_SIZE + 5 }, (_, i) => i + 1)
    fetchMock
      .mockResolvedValueOnce(page([1], 'next'))
      .mockResolvedValueOnce(page([2], null))
      .mockResolvedValueOnce(page([101], null))

    const pages = await collect(exportBooks({ token: TOKEN, ids: [...ids, 1, 2] }))

    expect(pages).toEqual([[1], [2], [101]])
    const urls = requestedUrls()
    const first = urls[0].searchParams.get('ids')!.split(',')
    expect(first).toHaveLength(EXPORT_IDS_BATCH_SIZE)
    expect(urls[1].searchParams.get('ids')).toBe(urls[0].searchParams.get('ids'))
    expect(urls[1].searchParams.get('pageCursor')).toBe('next')
    expect(urls[2].searchParams.get('ids')).toBe('101,102,103,104,105')
    expect(urls[2].searchParams.has('pageCursor')).toBe(false)
  })

  it('makes no request for an empty id list', async () => {
    expect(await collect(exportBooks({ token: TOKEN, ids: [] }))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('rate limiting', () => {
  it('waits Retry-After seconds on a 429, then retries', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '7' } }))
      .mockResolvedValueOnce(page([1], null))

    const pending = collect(exportPages({ token: TOKEN, includeDeleted: false }))
    await vi.advanceTimersByTimeAsync(6_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual([[1]])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a typed rate-limited error after repeated 429s', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
    )
    const pending = verifyToken(TOKEN).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    const error = (await pending) as ReadwiseError
    expect(error).toBeInstanceOf(ReadwiseError)
    expect(error.code).toBe('rate-limited')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('caps an oversized Retry-After', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'Retry-After': '99999' } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const pending = verifyToken(TOKEN)
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('stops waiting when aborted during Retry-After', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    fetchMock.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '30' } })
    )
    const pending = verifyToken(TOKEN, controller.signal).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort()
    expect(((await pending) as Error).name).toBe('AbortError')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('readwiseGet', () => {
  it('only ever talks to readwise.io, whatever the path', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(readwiseGet({ token: TOKEN, path: '//evil.example/x' })).rejects.toThrow(
      'Readwise requests must stay on readwise.io'
    )
    await expect(readwiseGet({ token: TOKEN, path: 'https://evil.example/x' })).rejects.toThrow(
      'Readwise requests must stay on readwise.io'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
