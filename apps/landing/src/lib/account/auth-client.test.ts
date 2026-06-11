import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import sodium from 'libsodium-wrappers-sumo'
import { registerWebDevice } from './auth-client.ts'
import { createAuthStorage } from './auth-storage.ts'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
}

describe('registerWebDevice', () => {
  it('registers a device with a signed challenge and stores the session', async () => {
    await sodium.ready
    const storage = createAuthStorage(memoryStorage())
    const setupToken = `h.${Buffer.from(JSON.stringify({ jti: 'jti-1' })).toString('base64url')}.s`
    let body: Record<string, unknown> = {}
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init!.body as string) as Record<string, unknown>
      return new Response(
        JSON.stringify({ deviceId: 'dev-1', accessToken: 'a', refreshToken: 'r' }),
        { status: 200 }
      )
    }
    await registerWebDevice({
      setupToken,
      baseUrl: 'https://s',
      storage,
      fetchImpl: fakeFetch as typeof fetch
    })
    assert.equal(body.platform, 'web')
    assert.equal(typeof body.authPublicKey, 'string')
    assert.deepEqual(storage.getSession(), {
      accessToken: 'a',
      refreshToken: 'r',
      deviceId: 'dev-1'
    })
  })
})
