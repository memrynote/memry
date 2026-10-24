import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COLOR_THEME_STORAGE_KEY } from '@memry/contracts/color-themes'
import { applyStartupState } from './index'
import { LOCALE_STORAGE_KEY } from './apply-locale'
import { ZOOM_STORAGE_KEY } from './apply-zoom'
import { THEME_STORAGE_KEY } from '../startup-theme'

const baseState = {
  theme: 'system',
  locale: 'en',
  zoom: 1,
  platform: 'darwin',
  colorTheme: null,
  startupVault: null
}

function resetRoot(): void {
  const root = document.documentElement
  root.className = ''
  root.removeAttribute('lang')
  root.removeAttribute('dir')
  root.removeAttribute('data-platform')
  root.removeAttribute('style')
}

beforeEach(() => {
  window.localStorage.clear()
  resetRoot()
})

afterEach(() => {
  window.__MEMRY_STARTUP__ = undefined
  resetRoot()
})

describe('applyStartupState', () => {
  it('applies the startup state and writes the caches', () => {
    window.__MEMRY_STARTUP__ = {
      ...baseState,
      theme: 'dark',
      locale: 'ar',
      zoom: 1.3,
      platform: 'win32'
    }

    applyStartupState()

    const root = document.documentElement
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    expect(root.getAttribute('data-platform')).toBe('win32')
    expect(root.getAttribute('lang')).toBe('ar')
    expect(root.getAttribute('dir')).toBe('rtl')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ar')
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.3')
  })

  it('applies the white theme as a class', () => {
    window.__MEMRY_STARTUP__ = { ...baseState, theme: 'white' }

    applyStartupState()

    expect(document.documentElement.classList.contains('white')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('falls back to the localStorage caches when there is no startup state', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '1.5')

    applyStartupState()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.5')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
    expect(document.documentElement.getAttribute('data-platform')).toBeTruthy()
  })

  it('ignores a corrupt color theme cache instead of throwing', () => {
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, '{not json')

    expect(() => applyStartupState()).not.toThrow()
  })
})
