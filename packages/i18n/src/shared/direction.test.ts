import { describe, it, expect } from 'vitest'
import { localeDirection, resolveLocaleDirection } from './direction'

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

  it('returns ltr for a structurally invalid locale instead of throwing', () => {
    expect(localeDirection('')).toBe('ltr')
    expect(localeDirection('!!not-a-locale!!')).toBe('ltr')
  })
})

describe('resolveLocaleDirection', () => {
  it('uses getTextInfo() when present (V8 15 / Chromium 150)', () => {
    expect(resolveLocaleDirection({ getTextInfo: () => ({ direction: 'rtl' }) })).toBe('rtl')
  })

  it('falls back to the textInfo getter on older runtimes', () => {
    expect(resolveLocaleDirection({ textInfo: { direction: 'rtl' } })).toBe('rtl')
  })

  it('returns ltr when neither shape is present', () => {
    expect(resolveLocaleDirection({})).toBe('ltr')
  })
})
