import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTheme } from 'next-themes'
import { useGeneralSettings } from './use-general-settings'
import { useThemeSync } from './use-theme-sync'

vi.mock('next-themes', () => ({
  useTheme: vi.fn()
}))

vi.mock('./use-general-settings', () => ({
  useGeneralSettings: vi.fn()
}))

const defaultSettings = {
  theme: 'system' as const,
  fontSize: 'medium' as const,
  fontSizePx: 16 as number | undefined,
  fontFamily: 'system' as const,
  customFontFamily: '',
  accentColor: '#6366f1',
  colorTheme: 'memrynote',
  useThemeAccent: true,
  backgroundLight: '',
  foregroundLight: '',
  backgroundDark: '',
  foregroundDark: '',
  reduceMotion: 'system' as 'system' | 'on',
  pointerCursors: false,
  fontSmoothing: false,
  startOnBoot: false,
  language: 'en'
}

describe('useThemeSync', () => {
  const setTheme = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    for (const attr of [
      'data-color-theme',
      'data-reduce-motion',
      'data-pointer-cursors',
      'data-font-smoothing'
    ]) {
      document.documentElement.removeAttribute(attr)
    }
    window.localStorage.clear()
    vi.mocked(useTheme).mockReturnValue({ setTheme } as ReturnType<typeof useTheme>)
  })

  it('does not sync placeholder settings while the real settings are still loading', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: defaultSettings,
      isLoading: true,
      error: null,
      updateSettings: vi.fn()
    })

    renderHook(() => useThemeSync())

    expect(setTheme).not.toHaveBeenCalled()
    expect(document.documentElement.style.fontSize).toBe('')
    expect(document.documentElement.style.getPropertyValue('--user-accent-color')).toBe('')
  })

  it('applies the loaded theme and appearance settings after loading completes', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: {
        ...defaultSettings,
        theme: 'light',
        fontSize: 'large',
        fontSizePx: 20,
        fontFamily: 'serif',
        accentColor: '#123456'
      },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    renderHook(() => useThemeSync())

    expect(setTheme).toHaveBeenCalledWith('light')
    expect(document.documentElement.style.getPropertyValue('--user-accent-color')).toBe('#123456')
    expect(document.documentElement.style.fontSize).toBe('20px')
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain(
      'Crimson Pro Variable'
    )
  })

  it('paints the color theme and caches it for the next launch', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: { ...defaultSettings, colorTheme: 'nord' },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    const { rerender } = renderHook(() => useThemeSync())

    const root = document.documentElement
    expect(root.getAttribute('data-color-theme')).toBe('nord')
    expect(root.style.getPropertyValue('--ct-dark-bg')).toBe('#2e3440')
    expect(JSON.parse(window.localStorage.getItem('memry-color-theme') ?? '{}')).toMatchObject({
      colorTheme: 'nord'
    })

    // Back to the built-in palette: nothing of the theme may linger.
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: { ...defaultSettings, colorTheme: 'memrynote' },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })
    rerender()

    expect(root.hasAttribute('data-color-theme')).toBe(false)
    expect(root.style.getPropertyValue('--ct-dark-bg')).toBe('')
  })

  it('marks the root for the per-install advanced appearance options', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: {
        ...defaultSettings,
        reduceMotion: 'on',
        pointerCursors: true,
        fontSmoothing: true
      },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    const { result } = renderHook(() => useThemeSync())

    const root = document.documentElement
    expect(root.getAttribute('data-reduce-motion')).toBe('on')
    expect(root.hasAttribute('data-pointer-cursors')).toBe(true)
    expect(root.hasAttribute('data-font-smoothing')).toBe(true)
    expect(result.current.reduceMotion).toBe('on')
  })

  it('#given settings written before the slider shipped #then the legacy bucket sets the root size', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: { ...defaultSettings, fontSize: 'small', fontSizePx: undefined },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    renderHook(() => useThemeSync())

    expect(document.documentElement.style.fontSize).toBe('14px')
  })

  it('#given a custom font #when synced #then it leads the stack and the chosen family follows', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: { ...defaultSettings, fontFamily: 'serif', customFontFamily: 'Iosevka Term' },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    renderHook(() => useThemeSync())

    const stack = document.documentElement.style.getPropertyValue('--font-sans')
    expect(stack.startsWith("'Iosevka Term',")).toBe(true)
    expect(stack).toContain('Crimson Pro Variable')
  })

  it('#given a custom font over the system family #when synced #then the system stack is the fallback', () => {
    vi.mocked(useGeneralSettings).mockReturnValue({
      settings: { ...defaultSettings, customFontFamily: '"Comic Sans MS"; color: red' },
      isLoading: false,
      error: null,
      updateSettings: vi.fn()
    })

    renderHook(() => useThemeSync())

    const stack = document.documentElement.style.getPropertyValue('--font-sans')
    expect(stack.startsWith("'Comic Sans MS color red',")).toBe(true)
    expect(stack).toContain('ui-sans-serif')
  })
})
