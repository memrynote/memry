import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSyncApi } from './sync-api.ts'
import { createAuthStorage } from './auth-storage.ts'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
}

describe('sync api', () => {
  it('retries once after refreshing on a 401', async () => {
    const storage = createAuthStorage(memoryStorage())
    storage.setSession({ accessToken: 'old', refreshToken: 'r', deviceId: 'd' })
    const calls: string[] = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (
        url.endsWith('/auth/billing') &&
        (init?.headers as Record<string, string>).Authorization === 'Bearer old'
      ) {
        return new Response('{}', { status: 401 })
      }
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'r2' }), {
          status: 200
        })
      }
      return new Response(JSON.stringify({ plan: 'pro' }), { status: 200 })
    }
    const api = createSyncApi({
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as typeof fetch
    })
    const res = await api.authedJson('/auth/billing')
    assert.deepEqual(res, { plan: 'pro' })
    assert.equal(storage.getSession()?.accessToken, 'new')
    assert.ok(calls.includes('https://s/auth/refresh'))
  })

  it('clears the session when refresh fails on a 401', async () => {
    const storage = createAuthStorage(memoryStorage())
    storage.setSession({ accessToken: 'old', refreshToken: 'r', deviceId: 'd' })
    const fakeFetch = async (url: string) => {
      if (url.endsWith('/auth/refresh')) return new Response('{}', { status: 401 })
      return new Response('{}', { status: 401 })
    }
    const api = createSyncApi({
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as typeof fetch
    })
    const res = await api.authedFetch('/auth/billing')
    assert.equal(res.status, 401)
    assert.equal(storage.getSession(), null)
  })
})
