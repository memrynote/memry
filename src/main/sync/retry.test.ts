import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkError, RateLimitError } from './http-client'
import { DeadLetterError, withRetry } from './retry'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('withRetry', () => {
  describe('#given successful fn #when called', () => {
    it('#then returns value with attempts=1', async () => {
      const fn = vi.fn().mockResolvedValue('ok')

      const result = await withRetry(fn)

      expect(result).toEqual({ value: 'ok', attempts: 1 })
      expect(fn).toHaveBeenCalledOnce()
    })
  })

  describe('#given fn fails once then succeeds #when retried', () => {
    it('#then returns value with attempts=2', async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok')

      const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, jitterMs: 0 })
      await vi.advanceTimersByTimeAsync(100)
      const result = await promise

      expect(result).toEqual({ value: 'ok', attempts: 2 })
      expect(fn).toHaveBeenCalledTimes(2)
    })
  })

  describe('#given fn always fails #when max retries exceeded', () => {
    it('#then throws DeadLetterError', async () => {
      const innerError = new Error('always fails')
      const fn = vi.fn().mockRejectedValue(innerError)

      const promise = withRetry(fn, { maxRetries: 2, baseDelayMs: 10, jitterMs: 0 })
      promise.catch(() => {})

      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(20)

      await expect(promise).rejects.toThrow(DeadLetterError)
      await expect(promise).rejects.toMatchObject({
        lastError: innerError,
        attempts: 3
      })
    })
  })

  describe('#given RateLimitError with retryAfter #when retried', () => {
    it('#then waits retryAfter seconds', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitError(5))
        .mockResolvedValue('ok')

      const promise = withRetry(fn, { maxRetries: 3 })

      await vi.advanceTimersByTimeAsync(5000)
      const result = await promise

      expect(result).toEqual({ value: 'ok', attempts: 2 })
    })
  })

  describe('#given NetworkError #when offline', () => {
    it('#then polls isOnline until true', async () => {
      let online = false
      const isOnline = vi.fn(() => online)
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new NetworkError('offline'))
        .mockResolvedValue('ok')

      const promise = withRetry(fn, { maxRetries: 3, isOnline })

      await vi.advanceTimersByTimeAsync(2000)
      expect(isOnline).toHaveBeenCalled()
      expect(fn).toHaveBeenCalledTimes(1)

      online = true
      await vi.advanceTimersByTimeAsync(2000)
      const result = await promise

      expect(result).toEqual({ value: 'ok', attempts: 2 })
    })
  })

  describe('#given aborted signal #when retrying', () => {
    it('#then throws AbortError', async () => {
      const controller = new AbortController()
      const fn = vi.fn().mockRejectedValue(new Error('fail'))

      const promise = withRetry(fn, {
        maxRetries: 5,
        baseDelayMs: 1000,
        jitterMs: 0,
        signal: controller.signal
      })
      promise.catch(() => {})

      await vi.advanceTimersByTimeAsync(500)
      controller.abort()
      await vi.advanceTimersByTimeAsync(500)

      await expect(promise).rejects.toThrow('The operation was aborted.')
    })
  })

  describe('#given already-aborted signal #when called', () => {
    it('#then throws AbortError immediately', async () => {
      const controller = new AbortController()
      controller.abort()
      const fn = vi.fn()

      await expect(
        withRetry(fn, { signal: controller.signal })
      ).rejects.toThrow('The operation was aborted.')
      expect(fn).not.toHaveBeenCalled()
    })
  })

  describe('#given onRetry callback #when retrying', () => {
    it('#then callback receives attempt, error, delay', async () => {
      const onRetry = vi.fn()
      const error = new Error('fail')
      const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('ok')

      const promise = withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 100,
        jitterMs: 0,
        onRetry
      })

      await vi.advanceTimersByTimeAsync(100)
      await promise

      expect(onRetry).toHaveBeenCalledOnce()
      expect(onRetry).toHaveBeenCalledWith(1, error, 100)
    })
  })

  describe('#given exponential backoff #when retrying', () => {
    it('#then delay doubles each attempt capped by maxDelay', async () => {
      const onRetry = vi.fn()
      const fn = vi.fn().mockRejectedValue(new Error('fail'))

      const promise = withRetry(fn, {
        maxRetries: 4,
        baseDelayMs: 100,
        maxDelayMs: 500,
        jitterMs: 0,
        onRetry
      })
      promise.catch(() => {})

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(500)
      }

      await expect(promise).rejects.toThrow(DeadLetterError)

      const delays = onRetry.mock.calls.map((call) => call[2])
      expect(delays).toEqual([100, 200, 400, 500])
    })
  })
})
