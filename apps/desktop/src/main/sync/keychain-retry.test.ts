import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recoveredListeners: new Set<() => void>(),
  logError: vi.fn(),
  logInfo: vi.fn()
}))

vi.mock('../secrets/secret-storage', () => ({
  onKeychainRecovered: (listener: () => void) => {
    mocks.recoveredListeners.add(listener)
    return () => mocks.recoveredListeners.delete(listener)
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: vi.fn(),
    error: mocks.logError
  })
}))

import {
  KEYCHAIN_RETRY_DELAYS_MS,
  KEYCHAIN_UNAVAILABLE_STATUS,
  getKeychainUnavailableStatus,
  pauseForKeychain,
  resetKeychainRetryForTests
} from './keychain-retry'

const UNREADABLE = new Error(
  'Failed to retrieve key from keychain (master-key): Secret com.memry.sync/master-key exists in the secret store but could not be read this run; refusing to report it as absent'
)
const LATCHED = new Error(
  'Failed to retrieve key from keychain (refresh-token): OS keychain is unavailable until it answers an earlier request (com.memry.sync/refresh-token)'
)
const LAST_DELAY = KEYCHAIN_RETRY_DELAYS_MS[KEYCHAIN_RETRY_DELAYS_MS.length - 1]

const fireKeychainRecovered = (): void => {
  for (const listener of [...mocks.recoveredListeners]) listener()
}

describe('keychain-retry', () => {
  const start = vi.fn(async (): Promise<unknown> => null)
  const emitStatus = vi.fn()
  const deps = { start, emitStatus }

  beforeEach(() => {
    vi.useFakeTimers()
    start.mockReset()
    start.mockResolvedValue(null)
    emitStatus.mockClear()
    mocks.logError.mockClear()
    mocks.logInfo.mockClear()
    mocks.recoveredListeners.clear()
    resetKeychainRetryForTests()
  })

  afterEach(() => {
    resetKeychainRetryForTests()
    vi.useRealTimers()
  })

  it('leaves errors that are not about the keychain to the caller', () => {
    expect(pauseForKeychain(new Error('network down'), deps)).toBe(false)
    expect(emitStatus).not.toHaveBeenCalled()
    expect(getKeychainUnavailableStatus()).toBeNull()
  })

  it('shows the paused status and reports only the first failure of an episode as an error', () => {
    expect(pauseForKeychain(UNREADABLE, deps)).toBe(true)
    expect(emitStatus).toHaveBeenCalledWith(KEYCHAIN_UNAVAILABLE_STATUS)
    expect(KEYCHAIN_UNAVAILABLE_STATUS).toMatchObject({
      status: 'error',
      errorCategory: 'keychain_unavailable',
      error: 'errors:sync.keychainUnavailable'
    })
    expect(getKeychainUnavailableStatus()).toBe(KEYCHAIN_UNAVAILABLE_STATUS)
    expect(mocks.logError).toHaveBeenCalledTimes(1)

    // Re-sent so a window that loaded after the first broadcast still sees it.
    expect(pauseForKeychain(LATCHED, deps)).toBe(true)
    expect(emitStatus).toHaveBeenCalledTimes(2)
    expect(mocks.logError).toHaveBeenCalledTimes(1)
  })

  it('retries the start on a growing backoff capped at the last delay', async () => {
    // Every retry fails the same way and re-arms the next one.
    start.mockImplementation(async () => {
      pauseForKeychain(UNREADABLE, deps)
      return null
    })
    pauseForKeychain(UNREADABLE, deps)

    for (let i = 0; i < KEYCHAIN_RETRY_DELAYS_MS.length + 2; i += 1) {
      const delay = KEYCHAIN_RETRY_DELAYS_MS[Math.min(i, KEYCHAIN_RETRY_DELAYS_MS.length - 1)]
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(start).toHaveBeenCalledTimes(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(start).toHaveBeenCalledTimes(i + 1)
    }
    expect(getKeychainUnavailableStatus()).toBe(KEYCHAIN_UNAVAILABLE_STATUS)
  })

  it('does not stack timers when several failures land before the retry fires', async () => {
    pauseForKeychain(UNREADABLE, deps)
    pauseForKeychain(LATCHED, deps)
    await vi.advanceTimersByTimeAsync(LAST_DELAY)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('retries immediately when the OS keychain answers again, instead of waiting out the backoff', async () => {
    pauseForKeychain(LATCHED, deps)
    fireKeychainRecovered()
    expect(start).toHaveBeenCalledTimes(1)

    // The pending backoff timer was dropped with it.
    await vi.advanceTimersByTimeAsync(LAST_DELAY)
    expect(start).toHaveBeenCalledTimes(1)
    expect(mocks.recoveredListeners.size).toBe(0)
  })

  it('ends the episode once a retry gets past the secrets, without emitting over its status', async () => {
    pauseForKeychain(UNREADABLE, deps)
    start.mockResolvedValueOnce({ engine: true })

    await vi.advanceTimersByTimeAsync(KEYCHAIN_RETRY_DELAYS_MS[0])

    expect(start).toHaveBeenCalledTimes(1)
    expect(getKeychainUnavailableStatus()).toBeNull()
    expect(emitStatus).toHaveBeenCalledTimes(1)
    // Nothing further is scheduled, and a new episode starts from the first step.
    await vi.advanceTimersByTimeAsync(LAST_DELAY)
    expect(start).toHaveBeenCalledTimes(1)
    pauseForKeychain(UNREADABLE, deps)
    expect(mocks.logError).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(KEYCHAIN_RETRY_DELAYS_MS[0])
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('swallows a rejected retry and keeps the next one armed', async () => {
    start.mockRejectedValueOnce(new Error('boom'))
    pauseForKeychain(UNREADABLE, deps)
    await vi.advanceTimersByTimeAsync(KEYCHAIN_RETRY_DELAYS_MS[0])
    expect(start).toHaveBeenCalledTimes(1)
    expect(getKeychainUnavailableStatus()).toBe(KEYCHAIN_UNAVAILABLE_STATUS)

    await vi.advanceTimersByTimeAsync(KEYCHAIN_RETRY_DELAYS_MS[1])
    expect(start).toHaveBeenCalledTimes(2)
  })
})
