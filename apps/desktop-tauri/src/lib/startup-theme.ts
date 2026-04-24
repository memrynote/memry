export const THEME_STORAGE_KEY = 'memry-theme'

export type StartupTheme = 'light' | 'dark' | 'white' | 'system'

const STARTUP_THEMES: readonly StartupTheme[] = ['light', 'dark', 'white', 'system'] as const

function isStartupTheme(value: string | null): value is StartupTheme {
  return value !== null && (STARTUP_THEMES as readonly string[]).includes(value)
}

/**
 * Synchronously resolve the startup theme before React mounts so the
 * window doesn't flash the wrong color scheme.
 *
 * In the Electron era a sync preload call (windowApi.settings
 * .getStartupThemeSync) read the persisted theme from disk. Tauri has no
 * sync JS→Rust channel, so we fall back to localStorage (written by the
 * theme provider after mount) and default to 'system' on first run.
 */
export function getStartupTheme(): StartupTheme {
  if (typeof localStorage === 'undefined') return 'system'
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return isStartupTheme(stored) ? stored : 'system'
}
