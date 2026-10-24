import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReadwiseError } from './client'
import {
  READER_REQUESTS_PER_MINUTE,
  RequestLimiter,
  listDocuments,
  type ReaderDocument
} from './reader'

const TOKEN = 'rw-secret-token'

function doc(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Doc ${id}`, category: 'article', location: 'new', parent_id: null, ...over }
}

function listPage(docs: Array<Record<string, unknown>>, next: string | null = null): Response {
  return new Response(JSON.stringify({ count: docs.length, nextPageCursor: next, results: docs }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

let fetchMock: ReturnType<typeof vi.fn>

function requested(): URL[] {
  return fetchMock.mock.calls.map((call) => new URL(call[0] as string))
}

async function ids(gen: AsyncGenerator<ReaderDocument[]>): Promise<string[]> {
  const out: string[] = []
  for await (const page of gen) out.push(...page.map((d) => d.id))
  return out
}

function newLimiter(): RequestLimiter {
  return new RequestLimiter(READER_REQUESTS_PER_MINUTE, 60_000)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('listDocuments', () => {
  it('reads the four saved locations and never requests feed', async () => {
    fetchMock.mockImplementation(() => listPage([]))
    await ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    expect(requested().map((url) => url.searchParams.get('location'))).toEqual([
      'new',
      'later',
      'shortlist',
      'archive'
    ])
    expect(requested().every((url) => url.pathname === '/api/v3/list/')).toBe(true)
    expect(requested()[0].searchParams.get('limit')).toBe('100')
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: `Token ${TOKEN}` })
  })

  it('follows pageCursor inside a location', async () => {
    fetchMock
      .mockResolvedValueOnce(listPage([doc('a')], 'c1'))
      .mockResolvedValueOnce(listPage([doc('b')], 'c2'))
      .mockResolvedValueOnce(listPage([doc('c')]))
      .mockImplementation(() => listPage([]))
    const result = await ids(
      listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() })
    )
    expect(result).toEqual(['a', 'b', 'c'])
    expect(
      requested()
        .slice(0, 3)
        .map((u) => u.searchParams.get('pageCursor'))
    ).toEqual([null, 'c1', 'c2'])
  })

  it('sends updatedAfter, and withHtmlContent only when asked', async () => {
    fetchMock.mockImplementation(() => listPage([]))
    await ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    expect(requested()[0].searchParams.has('withHtmlContent')).toBe(false)
    expect(requested()[0].searchParams.has('updatedAfter')).toBe(false)

    fetchMock.mockClear()
    await ids(
      listDocuments({
        token: TOKEN,
        withHtmlContent: true,
        updatedAfter: '2026-10-22T00:00:00.000Z',
        limiter: newLimiter()
      })
    )
    expect(requested()[0].searchParams.get('withHtmlContent')).toBe('true')
    expect(requested()[0].searchParams.get('updatedAfter')).toBe('2026-10-22T00:00:00.000Z')
  })

  it('drops documents with parent_id set and feed items', async () => {
    fetchMock
      .mockResolvedValueOnce(
        listPage([
          doc('top'),
          doc('child', { parent_id: 'top', category: 'highlight' }),
          doc('rss', { location: 'feed' })
        ])
      )
      .mockImplementation(() => listPage([]))
    expect(
      await ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    ).toEqual(['top'])
  })

  it('reads the live tags object and keeps unknown fields from failing', async () => {
    fetchMock
      .mockResolvedValueOnce(
        listPage([doc('t', { tags: { Reading: { name: 'Reading', type: 'manual' } }, extra: 1 })])
      )
      .mockImplementation(() => listPage([]))
    const pages: ReaderDocument[][] = []
    for await (const page of listDocuments({
      token: TOKEN,
      withHtmlContent: false,
      limiter: newLimiter()
    })) {
      pages.push(page)
    }
    expect(pages[0][0].tags).toEqual({ Reading: { name: 'Reading', type: 'manual' } })
  })

  it('rejects a page in an unknown shape as a server error', async () => {
    fetchMock.mockResolvedValueOnce(listPage([{ title: 'no id' }]))
    await expect(
      ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    ).rejects.toMatchObject({ code: 'server' })
  })

  it('maps 401 to invalid-token', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(
      ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    ).rejects.toBeInstanceOf(ReadwiseError)
  })

  it('waits Retry-After on 429 and retries the same page', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))
      .mockResolvedValueOnce(listPage([doc('a')]))
      .mockImplementation(() => listPage([]))
    const run = ids(listDocuments({ token: TOKEN, withHtmlContent: false, limiter: newLimiter() }))
    await vi.advanceTimersByTimeAsync(6_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await run).toEqual(['a'])
    expect(requested()[1].searchParams.get('location')).toBe('new')
  })

  it('aborts during the rate-limit wait', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => listPage([doc('x')], 'more'))
    const limiter = new RequestLimiter(1, 60_000)
    const controller = new AbortController()
    const run = ids(
      listDocuments({ token: TOKEN, withHtmlContent: false, limiter, signal: controller.signal })
    )
    const settled = run.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    controller.abort(new Error('stop'))
    expect(await settled).toMatchObject({ message: 'stop' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('RequestLimiter', () => {
  it('lets 20 requests through a minute and holds the 21st until the window moves', async () => {
    vi.useFakeTimers()
    const limiter = newLimiter()
    let granted = 0
    for (let i = 0; i < 21; i++) void limiter.acquire().then(() => granted++)
    await vi.advanceTimersByTimeAsync(0)
    expect(granted).toBe(20)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(granted).toBe(20)
    await vi.advanceTimersByTimeAsync(1)
    expect(granted).toBe(21)
  })
})
