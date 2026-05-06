import { describe, expect, it } from 'vitest'
import { formatAppVersionForDisplay } from './app-version-display'

describe('formatAppVersionForDisplay', () => {
  it('formats semver-safe release versions as public date versions', () => {
    expect(formatAppVersionForDisplay('2026.506.1')).toBe('v2026-05-06')
    expect(formatAppVersionForDisplay('2026.506.2')).toBe('v2026-05-06.2')
    expect(formatAppVersionForDisplay('2026.1101.3')).toBe('v2026-11-01.3')
  })

  it('falls back to the raw value for unknown or invalid versions', () => {
    expect(formatAppVersionForDisplay('1.0.0')).toBe('1.0.0')
    expect(formatAppVersionForDisplay('v2026-05-06')).toBe('v2026-05-06')
    expect(formatAppVersionForDisplay('2026.132.1')).toBe('2026.132.1')
  })
})
