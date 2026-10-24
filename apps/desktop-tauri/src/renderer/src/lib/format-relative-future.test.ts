import { describe, expect, it } from 'vitest'
import { formatRelativeFuture } from './format-relative-future'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const ahead = (s: number): string => new Date(NOW + s * 1000).toISOString()

describe('formatRelativeFuture', () => {
  it('picks the largest fitting unit', () => {
    expect(formatRelativeFuture(ahead(5 * 60), 'en', NOW)).toBe('in 5 minutes')
    expect(formatRelativeFuture(ahead(3 * 3600), 'en', NOW)).toBe('in 3 hours')
    expect(formatRelativeFuture(ahead(2 * 86400), 'en', NOW)).toBe('in 2 days')
  })

  it('reads under a minute, and a past time, as now', () => {
    expect(formatRelativeFuture(ahead(20), 'en', NOW)).toBe('now')
    expect(formatRelativeFuture(ahead(-60), 'en', NOW)).toBe('now')
  })
})
