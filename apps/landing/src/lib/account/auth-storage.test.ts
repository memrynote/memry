import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAuthStorage } from './auth-storage.ts'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k)
  }
}

describe('auth storage', () => {
  it('round-trips tokens and clears them', () => {
    const s = createAuthStorage(memoryStorage())
    s.setSession({ accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    assert.deepEqual(s.getSession(), { accessToken: 'a', refreshToken: 'r', deviceId: 'd' })
    s.clearSession()
    assert.equal(s.getSession(), null)
  })

  it('persists the device keypair separately from the session', () => {
    const s = createAuthStorage(memoryStorage())
    s.setDeviceKeypair({ publicKeyBase64: 'p', signingKeyBase64: 'k' })
    s.clearSession()
    assert.deepEqual(s.getDeviceKeypair(), { publicKeyBase64: 'p', signingKeyBase64: 'k' })
  })
})
