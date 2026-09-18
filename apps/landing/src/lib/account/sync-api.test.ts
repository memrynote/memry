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

  it('clears the session on a 403 AUTH_DEVICE_REVOKED', async () => {
    const storage = createAuthStorage(memoryStorage())
    storage.setSession({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    let cleared = 0
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: 'AUTH_DEVICE_REVOKED', message: 'Device has been revoked' }
        }),
        { status: 403 }
      )
    const api = createSyncApi({
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as unknown as typeof fetch,
      onSessionCleared: () => {
        cleared += 1
      }
    })

    const res = await api.authedFetch('/auth/checkout-token', { method: 'POST' })

    assert.equal(res.status, 403)
    assert.equal(storage.getSession(), null)
    assert.equal(cleared, 1)
    // Body stays readable for the caller after the revoked-device sniff.
    assert.match(await res.text(), /AUTH_DEVICE_REVOKED/)
  })

  it('leaves the session intact on an unrelated 403', async () => {
    const storage = createAuthStorage(memoryStorage())
    storage.setSession({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    const fakeFetch = async () =>
      new Response(JSON.stringify({ error: { code: 'STORAGE_UNAUTHORIZED' } }), { status: 403 })
    const api = createSyncApi({
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as unknown as typeof fetch
    })

    await api.authedFetch('/sync/blob/x')

    assert.equal(storage.getSession()?.accessToken, 'a')
  })
})
