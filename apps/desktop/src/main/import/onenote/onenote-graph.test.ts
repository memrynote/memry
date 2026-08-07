/**
 * Unit tests for the OneNote Graph client: pagination, tree building, 429
 * backoff, 401 refresh-retry, transient retries and binary downloads — all
 * with an injected fetch, no live auth.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createOneNoteGraphClient,
  flattenNotebookSections,
  type GraphClientDeps
} from './onenote-graph'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: {}
}))

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

function makeDeps(
  fetchImpl: (url: string) => Promise<Response> | Response,
  overrides: Partial<GraphClientDeps> = {}
): GraphClientDeps {
  return {
    getAccessToken: vi.fn(async () => 'token'),
    fetch: async (url) => fetchImpl(url),
    isCancelled: () => false,
    status: () => {},
    ...overrides
  }
}

describe('createOneNoteGraphClient', () => {
  it('follows @odata.nextLink pagination', async () => {
    const calls: string[] = []
    const client = createOneNoteGraphClient(
      makeDeps((url) => {
        calls.push(url)
        if (url.includes('page2')) {
          return json({ value: [{ id: 'nb2', displayName: 'Two' }] })
        }
        return json({
          value: [{ id: 'nb1', displayName: 'One' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2'
        })
      })
    )
    const notebooks = await client.listNotebooks()
    expect(notebooks.map((n) => n.id)).toEqual(['nb1', 'nb2'])
    expect(calls).toHaveLength(2)
  })

  it('builds the notebook tree with nested section groups', async () => {
    const client = createOneNoteGraphClient(
      makeDeps((url) => {
        if (url.includes('/notebooks?')) {
          return json({ value: [{ id: 'nb', displayName: 'Work' }] })
        }
        if (url.includes('/notebooks/nb/sections')) {
          return json({ value: [{ id: 's1', displayName: 'Top Section' }] })
        }
        if (url.includes('/notebooks/nb/sectionGroups')) {
          return json({ value: [{ id: 'g1', displayName: 'Group 1' }] })
        }
        if (url.includes('/sectionGroups/g1/sections')) {
          return json({ value: [{ id: 's2', displayName: 'Inner Section' }] })
        }
        if (url.includes('/sectionGroups/g1/sectionGroups')) {
          return json({ value: [{ id: 'g2', displayName: 'Group 2' }] })
        }
        if (url.includes('/sectionGroups/g2/sections')) {
          return json({ value: [{ id: 's3', displayName: 'Deep Section' }] })
        }
        if (url.includes('/sectionGroups/g2/sectionGroups')) {
          return json({ value: [] })
        }
        throw new Error(`unexpected url ${url}`)
      })
    )

    const trees = await client.listNotebookTrees()
    expect(trees).toHaveLength(1)
    expect(trees[0].sections.map((s) => s.id)).toEqual(['s1'])
    expect(trees[0].sectionGroups[0].sections.map((s) => s.id)).toEqual(['s2'])
    expect(trees[0].sectionGroups[0].sectionGroups[0].sections.map((s) => s.id)).toEqual(['s3'])

    const flat = flattenNotebookSections(trees[0])
    expect(flat).toEqual([
      { id: 's1', displayName: 'Top Section', notebookId: 'nb' },
      { id: 's2', displayName: 'Inner Section', notebookId: 'nb', groupPath: ['Group 1'] },
      {
        id: 's3',
        displayName: 'Deep Section',
        notebookId: 'nb',
        groupPath: ['Group 1', 'Group 2']
      }
    ])
  })

  it('lists pages with level + timestamps', async () => {
    const client = createOneNoteGraphClient(
      makeDeps((url) => {
        expect(url).toContain('pagelevel=true')
        expect(url).toContain('%24orderby=order')
        return json({
          value: [
            {
              id: 'p1',
              title: 'Hello',
              createdDateTime: '2024-01-01T00:00:00Z',
              lastModifiedDateTime: '2024-02-01T00:00:00Z',
              level: 1
            }
          ]
        })
      })
    )
    const pages = await client.listPages('s1')
    expect(pages[0]).toEqual({
      id: 'p1',
      title: 'Hello',
      sectionId: 's1',
      createdDateTime: '2024-01-01T00:00:00Z',
      lastModifiedDateTime: '2024-02-01T00:00:00Z',
      level: 1
    })
  })

  it('backs off on 429 (honouring Retry-After) and reports it', async () => {
    let calls = 0
    const onRateLimited = vi.fn()
    const client = createOneNoteGraphClient(
      makeDeps(
        () => {
          calls++
          if (calls === 1) {
            return new Response('slow down', {
              status: 429,
              headers: { 'Retry-After': '1' }
            })
          }
          return json({ value: [{ id: 'nb', displayName: 'After backoff' }] })
        },
        { onRateLimited }
      )
    )
    const start = Date.now()
    const notebooks = await client.listNotebooks()
    expect(notebooks[0].displayName).toBe('After backoff')
    expect(onRateLimited).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeGreaterThanOrEqual(900)
  })

  it('refreshes the token once on 401 and retries', async () => {
    let calls = 0
    const getAccessToken = vi.fn(async (force?: boolean) => (force ? 'fresh' : 'stale'))
    const seenTokens: string[] = []
    const client = createOneNoteGraphClient({
      getAccessToken,
      fetch: async (_url, init) => {
        calls++
        const auth = (init.headers as Record<string, string>).Authorization
        seenTokens.push(auth)
        if (calls === 1) return new Response('unauthorized', { status: 401 })
        return json({ value: [] })
      },
      isCancelled: () => false,
      status: () => {}
    })
    await client.listNotebooks()
    expect(seenTokens).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('retries transient 5xx responses before failing', async () => {
    let calls = 0
    const client = createOneNoteGraphClient(
      makeDeps(() => {
        calls++
        if (calls < 3) return new Response('boom', { status: 500 })
        return json({ value: [] })
      })
    )
    await expect(client.listNotebooks()).resolves.toEqual([])
    expect(calls).toBe(3)
  })

  it('throws on non-retryable errors with the response detail', async () => {
    const client = createOneNoteGraphClient(
      makeDeps(() => new Response('{"error":{"code":"Forbidden"}}', { status: 403 }))
    )
    await expect(client.listNotebooks()).rejects.toThrow(/403/)
  })

  it('stops when cancelled', async () => {
    const fetchSpy = vi.fn()
    const client = createOneNoteGraphClient(makeDeps(fetchSpy, { isCancelled: () => true }))
    await expect(client.getPageContent('p1')).rejects.toThrow(/cancelled/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('downloads binaries as Buffers', async () => {
    const client = createOneNoteGraphClient(
      makeDeps(() => new Response(Uint8Array.from([1, 2, 3]), { status: 200 }))
    )
    const buffer = await client.fetchBinary('https://graph.microsoft.com/v1.0/res/1/$value')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect([...buffer]).toEqual([1, 2, 3])
  })
})

describe('createOneNoteGraphClient retry semantics', () => {
  it('honours Retry-After: 0 instead of waiting the default minute', async () => {
    let calls = 0
    const client = createOneNoteGraphClient(
      makeDeps(() => {
        calls++
        if (calls === 1) {
          return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
        }
        return json({ value: [] })
      })
    )
    const start = Date.now()
    await client.listNotebooks()
    expect(Date.now() - start).toBeLessThan(500)
    expect(calls).toBe(2)
  })

  it('refreshes the token once per 401, not on every later backoff round', async () => {
    const forced: boolean[] = []
    let calls = 0
    const client = createOneNoteGraphClient({
      getAccessToken: async (force?: boolean) => {
        forced.push(Boolean(force))
        return 'token'
      },
      fetch: async () => {
        calls++
        if (calls === 1) return new Response('unauthorized', { status: 401 })
        if (calls === 2) {
          return new Response('slow', { status: 429, headers: { 'Retry-After': '0' } })
        }
        return json({ value: [] })
      },
      isCancelled: () => false,
      status: () => {}
    })
    await client.listNotebooks()
    // Only the attempt directly after the 401 forces a refresh.
    expect(forced).toEqual([false, true, false])
  })
})
