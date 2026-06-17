import { describe, it, expect, vi, beforeEach } from 'vitest'

const secrets = new Map<string, string>()
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(async (s: string, a: string) => secrets.get(`${s}:${a}`) ?? null),
    setPassword: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}:${a}`, v)),
    deletePassword: vi.fn(async (s: string, a: string) => secrets.delete(`${s}:${a}`))
  }
}))
const config = new Map<string, unknown>()
vi.mock('../store', () => ({
  store: {
    get: (k: string) => config.get(k),
    set: (k: string, v: unknown) => void config.set(k, v)
  }
}))

describe('pairing', () => {
  beforeEach(() => {
    secrets.clear()
    config.clear()
    vi.resetModules()
  })

  it('generates a token once and returns the same value', async () => {
    const { getCaptureToken } = await import('./pairing')
    const a = await getCaptureToken()
    const b = await getCaptureToken()
    expect(a).toHaveLength(64) // 32 bytes hex
    expect(a).toBe(b)
  })

  it('claims pairing only while the window is open, recording the origin', async () => {
    const { openPairingWindow, claimPairing, isOriginAllowed } = await import('./pairing')
    expect(await claimPairing('chrome-extension://abc')).toBeNull() // window closed
    openPairingWindow()
    const res = await claimPairing('chrome-extension://abc')
    expect(res?.token).toHaveLength(64)
    expect(isOriginAllowed('chrome-extension://abc')).toBe(true)
    expect(isOriginAllowed('https://evil.com')).toBe(false)
  })

  it('rotate clears the allowlist and changes the token', async () => {
    const { openPairingWindow, claimPairing, rotateCaptureToken, isOriginAllowed } =
      await import('./pairing')
    openPairingWindow()
    const first = await claimPairing('chrome-extension://abc')
    const next = await rotateCaptureToken()
    expect(next).not.toBe(first?.token)
    expect(isOriginAllowed('chrome-extension://abc')).toBe(false)
  })
})
