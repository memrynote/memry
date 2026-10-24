export const THEME_STORAGE_KEY = 'memry-theme'

export type StartupTheme = 'light' | 'dark' | 'white' | 'system'

export function getStartupTheme(): StartupTheme {
  const theme = window.__MEMRY_STARTUP__?.theme
  return theme === 'light' || theme === 'dark' || theme === 'white' ? theme : 'system'
}
