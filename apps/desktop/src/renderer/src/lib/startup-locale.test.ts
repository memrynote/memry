import { describe, it, expect, afterEach } from 'vitest'
import { getStartupLocale } from './startup-locale'

// `tests/setup-dom.ts` defines window.api as writable but not configurable, so
// this assigns over it and puts the shared mock back rather than deleting.
const windowTarget = window as unknown as { api?: unknown }
const originalApi = windowTarget.api

afterEach(() => {
  windowTarget.api = originalApi
})

describe('getStartupLocale', () => {
  it('returns what the preload resolved', () => {
    windowTarget.api = { locale: { getStartupSync: () => 'tr' } }

    expect(getStartupLocale()).toBe('tr')
  })

  it('falls back to English when the preload bridge is missing', () => {
    windowTarget.api = undefined

    expect(getStartupLocale()).toBe('en')
  })

  it('falls back to English when the bridge answers with an unsupported locale', () => {
    windowTarget.api = { locale: { getStartupSync: () => 'klingon' } }

    expect(getStartupLocale()).toBe('en')
  })

  it('falls back to English when the bridge has no locale API at all', () => {
    windowTarget.api = {}

    expect(getStartupLocale()).toBe('en')
  })
})
