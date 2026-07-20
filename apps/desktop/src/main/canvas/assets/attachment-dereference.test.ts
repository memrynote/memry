import { describe, expect, it, vi } from 'vitest'
import { dereferenceChunks, type DereferenceDeps } from './attachment-dereference'

function makeDeps(overrides: Partial<DereferenceDeps> = {}): DereferenceDeps {
  return {
    getAccessToken: vi.fn().mockResolvedValue('test-token'),
    getSyncServerUrl: () => 'https://sync.example.com',
    getVaultId: () => 'vault-1',
    ...overrides
  }
}

describe('dereferenceChunks', () => {
  it('posts to /sync/attachments/dereference and returns ok on 200', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const deps = makeDeps({ fetchFn })

    const result = await dereferenceChunks(['chunk-1', 'chunk-2'], deps)

    expect(result).toEqual({ ok: true, status: 200 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://sync.example.com/sync/attachments/dereference')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      'X-Memry-Vault-Id': 'vault-1'
    })
    expect(JSON.parse(init.body as string)).toEqual({ chunkHashes: ['chunk-1', 'chunk-2'] })
  })

  it('returns {ok:false} on a 404 without throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const deps = makeDeps({ fetchFn })

    const result = await dereferenceChunks(['chunk-1'], deps)

    expect(result).toEqual({ ok: false, status: 404 })
  })

  it('returns {ok:false, status:0} on a network error without throwing', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    const deps = makeDeps({ fetchFn })

    const result = await dereferenceChunks(['chunk-1'], deps)

    expect(result).toEqual({ ok: false, status: 0 })
  })

  it('returns {ok:true, status:200} without calling fetch for empty chunkHashes', async () => {
    const fetchFn = vi.fn()
    const deps = makeDeps({ fetchFn })

    const result = await dereferenceChunks([], deps)

    expect(result).toEqual({ ok: true, status: 200 })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns {ok:false, status:0} without calling fetch when there is no access token', async () => {
    const fetchFn = vi.fn()
    const deps = makeDeps({ fetchFn, getAccessToken: vi.fn().mockResolvedValue(null) })

    const result = await dereferenceChunks(['chunk-1'], deps)

    expect(result).toEqual({ ok: false, status: 0 })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
