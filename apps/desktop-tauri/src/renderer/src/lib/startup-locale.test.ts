import { describe, it, expect, afterEach } from 'vitest'
import { getStartupLocale } from './startup-locale'

const state = { theme: 'system', zoom: 1, platform: 'darwin', colorTheme: null, startupVault: null }

afterEach(() => {
  window.__MEMRY_STARTUP__ = undefined
})

describe('getStartupLocale', () => {
  it('returns what the startup state carries', () => {
    window.__MEMRY_STARTUP__ = { ...state, locale: 'tr' }

    expect(getStartupLocale()).toBe('tr')
  })

  it('falls back to English when there is no startup state', () => {
    window.__MEMRY_STARTUP__ = undefined

    expect(getStartupLocale()).toBe('en')
  })

  it('falls back to English when the state carries an unsupported locale', () => {
    window.__MEMRY_STARTUP__ = { ...state, locale: 'klingon' }

    expect(getStartupLocale()).toBe('en')
  })
})
