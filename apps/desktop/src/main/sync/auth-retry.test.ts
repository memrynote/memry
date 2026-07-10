import { describe, expect, it, vi } from 'vitest'
import { SyncServerError } from './http-client'
import { withAuthRetry } from './auth-retry'

const unauthorized = (): SyncServerError => new SyncServerError('Token expired: "exp" claim', 401)

const deps = (overrides?: {
  refreshAccessToken?: () => Promise<boolean>
  getAccessToken?: () => Promise<string | null>
}): {
  refreshAccessToken: ReturnType<typeof vi.fn>
  getAccessToken: ReturnType<typeof vi.fn>
} => ({
  refreshAccessToken: vi.fn(overrides?.refreshAccessToken ?? (async () => true)),
  getAccessToken: vi.fn(overrides?.getAccessToken ?? (async () => 'fresh-token'))
})

describe('withAuthRetry', () => {
  it('returns the result without refreshing when the request succeeds', async () => {
    const d = deps()
    const fn = vi.fn(async (token: string) => `ok:${token}`)

    await expect(withAuthRetry(fn, 'stale-token', d)).resolves.toBe('ok:stale-token')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(d.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes once on 401 and retries with the fresh token', async () => {
    const d = deps()
    const fn = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(unauthorized())
      .mockImplementation(async (token) => `ok:${token}`)
    const onNewToken = vi.fn()

    await expect(withAuthRetry(fn, 'stale-token', d, onNewToken)).resolves.toBe('ok:fresh-token')

    expect(d.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenNthCalledWith(1, 'stale-token')
    expect(fn).toHaveBeenNthCalledWith(2, 'fresh-token')
    expect(onNewToken).toHaveBeenCalledWith('fresh-token')
  })

  it('throws the original 401 when the refresh fails', async () => {
    const original = unauthorized()
    const d = deps({ refreshAccessToken: async () => false })
    const fn = vi.fn<(token: string) => Promise<string>>().mockRejectedValue(original)

    await expect(withAuthRetry(fn, 'stale-token', d)).rejects.toBe(original)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(d.getAccessToken).not.toHaveBeenCalled()
  })

  it('throws the original 401 when no fresh token is available after refresh', async () => {
    const original = unauthorized()
    const d = deps({ getAccessToken: async () => null })
    const fn = vi.fn<(token: string) => Promise<string>>().mockRejectedValue(original)

    await expect(withAuthRetry(fn, 'stale-token', d)).rejects.toBe(original)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not refresh on non-401 errors', async () => {
    const d = deps()
    const serverError = new SyncServerError('boom', 500)
    const fn = vi.fn<(token: string) => Promise<string>>().mockRejectedValue(serverError)

    await expect(withAuthRetry(fn, 'stale-token', d)).rejects.toBe(serverError)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(d.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('gives up after a single retry when the fresh token is also rejected', async () => {
    const d = deps()
    const second = unauthorized()
    const fn = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(second)

    await expect(withAuthRetry(fn, 'stale-token', d)).rejects.toBe(second)

    expect(fn).toHaveBeenCalledTimes(2)
    expect(d.refreshAccessToken).toHaveBeenCalledTimes(1)
  })
})
