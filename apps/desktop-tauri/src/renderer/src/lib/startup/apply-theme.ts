import { THEME_STORAGE_KEY, type StartupTheme, getStartupTheme } from '../startup-theme'

function isStartupTheme(value: unknown): value is StartupTheme {
  return value === 'light' || value === 'dark' || value === 'white' || value === 'system'
}

/**
 * The theme to boot with: the startup state first, the localStorage cache second (a page with
 * no startup state), `system` last.
 * Port of `getStartupThemeSync` in the Electron preload.
 */
export function resolveStartupTheme(): StartupTheme {
  if (window.__MEMRY_STARTUP__) return getStartupTheme()
  try {
    const cached = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isStartupTheme(cached)) return cached
  } catch {
    // localStorage may be unavailable; fall through
  }
  return 'system'
}

function resolveEffectiveTheme(theme: StartupTheme): 'light' | 'dark' | 'white' {
  if (theme !== 'system') return theme
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyStartupTheme(theme: StartupTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The cache only buys a faster next launch
  }
  const effective = resolveEffectiveTheme(theme)

  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    root.classList.remove('dark', 'white')
    if (effective === 'dark') root.classList.add('dark')
    if (effective === 'white') root.classList.add('white')
    root.style.colorScheme = effective === 'dark' ? 'dark' : 'light'
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener('DOMContentLoaded', () => void applyToRoot(), { once: true })
  }
}
