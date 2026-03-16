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
    expect(document.documentElement.style.fontSize).toBe('18px')
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain(
      'Crimson Pro Variable'
    )
  })
})
