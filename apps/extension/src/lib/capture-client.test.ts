import { describe, expect, test, vi } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import {
  PROBE_PORTS,
  captureHeaders,
  claimToken,
  pairRequestUrl,
  parsePing,
  pingUrl,
  pollUntil,
  postCapture,
  probeServer,
  requestPair
} from './capture-client'

const draft: ArticleCapture = {
  url: 'https://example.com/p',
  mode: 'article',
  contentMarkdown: '# Hi',
  excerpt: 'Hi',
  extractionStatus: 'full',
  properties: { title: 'Hi', source: 'https://example.com/p', created: 'now', tags: ['clippings'] }
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

describe('probe range', () => {
  test('covers 7849..7856', () => {
    expect(PROBE_PORTS).toEqual([7849, 7850, 7851, 7852, 7853, 7854, 7855, 7856])
    expect(pingUrl(7849)).toBe('http://127.0.0.1:7849/ping')
  })
})

describe('parsePing', () => {
  test('accepts a memry ping', () => {
    expect(parsePing({ app: 'memry', version: '1.0.0', paired: true })?.paired).toBe(true)
  })
  test('rejects a foreign server', () => {
    expect(parsePing({ app: 'other', paired: true })).toBeNull()
    expect(parsePing('nope')).toBeNull()
  })
})

describe('captureHeaders', () => {
  test('carries all three required signals', () => {
    const h = captureHeaders('abc')
    expect(h.Authorization).toBe('Bearer abc')
    expect(h['X-Memry-Capture']).toBe('1')
    expect(h['Content-Type']).toBe('application/json')
  })
})

describe('probeServer', () => {
  test('returns the first listening memry port', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === pingUrl(7849)) throw new Error('ECONNREFUSED')
      if (url === pingUrl(7850)) return ok({ app: 'memry', version: '1', paired: false })
      throw new Error('ECONNREFUSED')
    })
    const found = await probeServer(fetchFn as unknown as typeof fetch)
    expect(found?.port).toBe(7850)
    expect(found?.ping.paired).toBe(false)
  })
  test('returns null when nothing is listening', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await probeServer(fetchFn as unknown as typeof fetch)).toBeNull()
  })
})

describe('claimToken', () => {
  test('returns token on 200, null otherwise', async () => {
    const good = vi.fn(async () => ok({ token: 't0ken', port: 7849 }))
    expect(await claimToken(7849, good as unknown as typeof fetch)).toBe('t0ken')
    const closed = vi.fn(async () => new Response('{}', { status: 403 }))
    expect(await claimToken(7849, closed as unknown as typeof fetch)).toBeNull()
  })
})

describe('postCapture', () => {
  test('maps 200 to itemId', async () => {
    const fetchFn = vi.fn(async () => ok({ itemId: 'item-1' }))
    expect(await postCapture(7849, 't', draft, fetchFn as unknown as typeof fetch)).toEqual({
      ok: true,
      itemId: 'item-1'
    })
  })
  test('maps error status to error code', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid-capture' }), { status: 422 })
    )
    expect(await postCapture(7849, 't', draft, fetchFn as unknown as typeof fetch)).toEqual({
      ok: false,
      error: 'invalid-capture'
    })
  })
})

describe('requestPair', () => {
  test('maps 200 to already-paired, 202 to pending, else error', async () => {
    const paired = vi.fn(
      async () => new Response(JSON.stringify({ status: 'already-paired' }), { status: 200 })
    )
    expect(await requestPair(7849, paired as unknown as typeof fetch)).toBe('already-paired')
    const pending = vi.fn(
      async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })
    )
    expect(await requestPair(7849, pending as unknown as typeof fetch)).toBe('pending')
    const denied = vi.fn(async () => new Response('{}', { status: 403 }))
    expect(await requestPair(7849, denied as unknown as typeof fetch)).toBe('error')
  })
  test('sends the X-Memry-Capture header', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 })
    )
    await requestPair(7849, fetchFn as unknown as typeof fetch)
    expect(fetchFn).toHaveBeenCalledWith(
      pairRequestUrl(7849),
      expect.objectContaining({ method: 'POST' })
    )
    const opts = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit
    expect((opts.headers as Record<string, string>)['X-Memry-Capture']).toBe('1')
  })
  test('returns error on network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('refused')
    })
    expect(await requestPair(7849, fetchFn as unknown as typeof fetch)).toBe('error')
  })
})

describe('pollUntil', () => {
  test('resolves on first non-null', async () => {
    let n = 0
    const r = await pollUntil(async () => (++n >= 3 ? 'done' : null), {
      intervalMs: 1,
      timeoutMs: 1000,
      sleep: async () => {}
    })
    expect(r).toBe('done')
  })
  test('returns null past the deadline', async () => {
    let t = 0
    const r = await pollUntil(async () => null, {
      intervalMs: 10,
      timeoutMs: 30,
      sleep: async () => {},
      now: () => (t += 20)
    })
    expect(r).toBeNull()
  })
})
