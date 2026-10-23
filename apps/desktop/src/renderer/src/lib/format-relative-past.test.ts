import { describe, expect, it } from 'vitest'
import { formatRelativePast } from './format-relative-past'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString()

describe('formatRelativePast', () => {
  it('picks the largest fitting unit', () => {
    expect(formatRelativePast(ago(5 * 60), 'en', NOW)).toBe('5 minutes ago')
    expect(formatRelativePast(ago(3 * 3600), 'en', NOW)).toBe('3 hours ago')
    expect(formatRelativePast(ago(2 * 86400), 'en', NOW)).toBe('2 days ago')
  })

  it('reads under a minute, and a future time, as now', () => {
    expect(formatRelativePast(ago(20), 'en', NOW)).toBe('now')
    expect(formatRelativePast(ago(-60), 'en', NOW)).toBe('now')
  })
})
