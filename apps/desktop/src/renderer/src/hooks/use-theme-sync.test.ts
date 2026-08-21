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
  fontFamily: 'system' as const,
  customFontFamily: '',
  accentColor: '#6366f1',
  startOnBoot: false,
  language: 'en'
}

describe('useThemeSync', () => {
  const setTheme = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
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
