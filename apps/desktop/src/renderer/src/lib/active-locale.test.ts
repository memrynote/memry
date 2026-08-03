import { afterEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_LOCALE, SUPPORTED_LOCALES } from '@memry/i18n/shared'
import { getActiveLocale, setActiveLocale } from './active-locale'

// Every pure formatting helper (time-format, format-task-due, repeat-utils,
// task-formatting, …) feeds getActiveLocale() straight into Intl, so the
// assertions below go through Intl too: they check the tag actually changes what
// users see, not just that a getter round-trips a string.
const JAN_15 = new Date(Date.UTC(2026, 0, 15))
const monthName = (locale: string): string =>
  new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(JAN_15)

afterEach(() => {
  setActiveLocale(FALLBACK_LOCALE)
})

describe('getActiveLocale', () => {
  // Fresh module instance so this is independent of the tests that mutate the
  // module-scoped `current` below — it asserts the value a just-booted renderer
  // sees before main.tsx has run setActiveLocale.
  it('defaults to the shared fallback locale before anything sets it', async () => {
    vi.resetModules()
    const fresh = await import('./active-locale')
    expect(fresh.getActiveLocale()).toBe(FALLBACK_LOCALE)
  })

  it('formats in English before a language is chosen, not in an arbitrary locale', async () => {
    vi.resetModules()
    const fresh = await import('./active-locale')
    expect(monthName(fresh.getActiveLocale())).toBe('January')
  })

  it('never returns undefined, which would follow the OS locale instead of the app locale', () => {
    expect(getActiveLocale()).toBeDefined()
    setActiveLocale('ja')
    expect(getActiveLocale()).toBeDefined()
  })
})

describe('setActiveLocale', () => {
  it('changes what getActiveLocale returns', () => {
    expect(getActiveLocale()).toBe(FALLBACK_LOCALE)
    setActiveLocale('de')
    expect(getActiveLocale()).toBe('de')
  })

  it('changes how Intl renders a date, not just the stored string', () => {
    expect(monthName(getActiveLocale())).toBe('January')
    setActiveLocale('de')
    expect(monthName(getActiveLocale())).toBe('Januar')
    setActiveLocale('fr')
    expect(monthName(getActiveLocale())).toBe('janvier')
  })

  it('overwrites an earlier call — the last language wins', () => {
    setActiveLocale('de')
    setActiveLocale('ja')
    expect(getActiveLocale()).toBe('ja')
    expect(monthName(getActiveLocale())).not.toBe(monthName('de'))
    expect(monthName(getActiveLocale())).toBe(monthName('ja'))
  })

  it('switching back to the fallback restores English formatting', () => {
    setActiveLocale('de')
    expect(monthName(getActiveLocale())).toBe('Januar')
    setActiveLocale(FALLBACK_LOCALE)
    expect(getActiveLocale()).toBe(FALLBACK_LOCALE)
    expect(monthName(getActiveLocale())).toBe('January')
  })

  it('is idempotent — setting the same locale twice keeps it', () => {
    setActiveLocale('tr')
    setActiveLocale('tr')
    expect(getActiveLocale()).toBe('tr')
  })

  it('keeps the region subtag of region-qualified locales', () => {
    setActiveLocale('zh-TW')
    expect(getActiveLocale()).toBe('zh-TW')
    expect(new Intl.Locale(getActiveLocale()).region).toBe('TW')

    setActiveLocale('zh-CN')
    expect(new Intl.Locale(getActiveLocale()).region).toBe('CN')
  })

  // A locale id Intl rejects would throw RangeError inside every date/time
  // helper the moment a user picked that language, so every shipped locale has
  // to survive the round trip into Intl.
  it.each(SUPPORTED_LOCALES)('%s round-trips into Intl as a usable BCP 47 tag', (locale) => {
    setActiveLocale(locale)
    expect(getActiveLocale()).toBe(locale)
    expect(() => monthName(getActiveLocale())).not.toThrow()
    expect(monthName(getActiveLocale())).not.toBe('')
    expect(new Intl.Locale(getActiveLocale()).language).toBe(locale.split('-')[0])
  })
})
