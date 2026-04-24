import { describe, it, expect, afterEach, vi } from 'vitest'
import { getAIConnections, parseConnectionDate, MIN_CONTENT_LENGTH } from './ai-connections-service'

describe('ai-connections-service', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns empty results for short content', async () => {
    const result = await getAIConnections('short')
    expect(result).toEqual([])
  })

  it('resolves mock connections after analysis delay', async () => {
    vi.useFakeTimers()

    const promise = getAIConnections('x'.repeat(MIN_CONTENT_LENGTH))
    await vi.advanceTimersByTimeAsync(2000)

    const result = await promise
    expect(result.length).toBeGreaterThan(0)
  })

  it('rejects when aborted', async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const promise = getAIConnections('x'.repeat(MIN_CONTENT_LENGTH), controller.signal)

    controller.abort()
    await expect(promise).rejects.toThrow('Aborted')
  })

  it('parses connection dates when possible', () => {
    expect(parseConnectionDate('Nov 15, 2024')).toBe('2024-11-15')
    expect(parseConnectionDate('not-a-date')).toBeNull()
  })
})
