import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyCustomThemeVariables,
  clearCustomThemeVariables,
  readCachedThemeOverrides,
  writeCachedThemeOverrides,
  clearCachedThemeOverrides,
  CUSTOM_THEME_OVERRIDES_STORAGE_KEY
} from './theme-overrides'

describe('applyCustomThemeVariables', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
  })

  it('sets valid hex variables inline', () => {
    applyCustomThemeVariables(root, { '--background': '#101010', '--surface': '#202020' })

    expect(root.style.getPropertyValue('--background')).toBe('#101010')
    expect(root.style.getPropertyValue('--surface')).toBe('#202020')
  })

  it('skips invalid values and non-custom-property keys', () => {
    applyCustomThemeVariables(root, {
      '--background': 'red',
      color: '#101010'
    })

    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(root.getAttribute('style') ?? '').not.toContain('red')
  })

  it('removes previously applied variables missing from the next apply', () => {
    applyCustomThemeVariables(root, { '--background': '#101010', '--surface': '#202020' })
    applyCustomThemeVariables(root, { '--background': '#303030' })

    expect(root.style.getPropertyValue('--background')).toBe('#303030')
    expect(root.style.getPropertyValue('--surface')).toBe('')
  })

  it('clearCustomThemeVariables removes everything it applied', () => {
    applyCustomThemeVariables(root, { '--background': '#101010' })
    clearCustomThemeVariables(root)

    expect(root.style.getPropertyValue('--background')).toBe('')
    expect(clearCustomThemeVariables(root)).toBeUndefined()
  })
})

describe('cached theme overrides (FOUC path)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('round-trips overrides through localStorage', () => {
    writeCachedThemeOverrides({ '--background': '#101010' })
    expect(readCachedThemeOverrides()).toEqual({ '--background': '#101010' })
  })

  it('sanitizes invalid entries on read', () => {
    window.localStorage.setItem(
      CUSTOM_THEME_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ '--background': 'red', '--surface': '#202020', nope: '#101010' })
    )
    expect(readCachedThemeOverrides()).toEqual({ '--surface': '#202020' })
  })

  it('returns null for corrupt or missing cache and clears cleanly', () => {
    expect(readCachedThemeOverrides()).toBeNull()
    window.localStorage.setItem(CUSTOM_THEME_OVERRIDES_STORAGE_KEY, '{broken')
    expect(readCachedThemeOverrides()).toBeNull()

    writeCachedThemeOverrides({ '--background': '#101010' })
    clearCachedThemeOverrides()
    expect(readCachedThemeOverrides()).toBeNull()
  })
})
