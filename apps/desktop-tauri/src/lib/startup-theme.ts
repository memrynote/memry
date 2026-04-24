export const THEME_STORAGE_KEY = 'memry-theme'

export type StartupTheme = 'light' | 'dark' | 'white' | 'system'

export function getStartupTheme(): StartupTheme {
  return window.api?.settings?.getStartupThemeSync?.() ?? 'system'
}
