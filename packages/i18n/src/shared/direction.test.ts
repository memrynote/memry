import { describe, it, expect } from 'vitest'
import { localeDirection } from './direction'

describe('localeDirection', () => {
  it('returns ltr for English', () => {
    expect(localeDirection('en')).toBe('ltr')
  })

  it('returns ltr for Turkish', () => {
    expect(localeDirection('tr')).toBe('ltr')
  })

  it('returns rtl for Arabic', () => {
    expect(localeDirection('ar')).toBe('rtl')
  })

  it('returns rtl for Hebrew (forward-compat for future locales)', () => {
    expect(localeDirection('he')).toBe('rtl')
  })

  it('returns ltr for unknown locale (Intl default behavior)', () => {
    expect(localeDirection('xx')).toBe('ltr')
  })
})
