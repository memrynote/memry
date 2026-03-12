export const THEME_STORAGE_KEY = 'memry-theme'

export type StartupTheme = 'light' | 'dark' | 'system'

export function getStartupTheme(): StartupTheme {
  return window.api?.settings?.getStartupThemeSync?.() ?? 'system'
}
