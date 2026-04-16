import { ipcRenderer } from 'electron'
import { SettingsChannels } from '@memry/contracts/ipc-channels'

export type StartupTheme = 'light' | 'dark' | 'white' | 'system'

export const THEME_STORAGE_KEY = 'memry-theme'

function isStartupTheme(value: unknown): value is StartupTheme {
  return value === 'light' || value === 'dark' || value === 'white' || value === 'system'
}

export function getStartupThemeSync(): StartupTheme {
  // Fast path: use the theme cached in localStorage from the previous run.
  // This avoids a synchronous IPC round-trip on every launch after the first.
  try {
    const cached = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isStartupTheme(cached)) return cached
  } catch {
    // localStorage may be unavailable; fall through to IPC
  }
  // First launch (or corrupted storage): fall back to synchronous IPC.
  // The main-process handler returns `{ theme, accentColor? }`, so unwrap it
  // and validate. Treating the object as a string here would propagate
  // `[object Object]` into next-themes' localStorage and crash the renderer.
  try {
    const raw = ipcRenderer.sendSync(SettingsChannels.sync.GET_STARTUP_THEME) as
      | StartupTheme
      | { theme?: StartupTheme }
      | null
      | undefined
    const value = typeof raw === 'string' ? raw : raw?.theme
    if (isStartupTheme(value)) return value
  } catch {
    // fall through
  }
  return 'system'
}

function resolveStartupTheme(theme: StartupTheme): 'light' | 'dark' | 'white' {
  if (theme === 'system') {
    return typeof globalThis.window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  return theme
}

export function applyStartupTheme(savedTheme: StartupTheme): void {
  const resolvedTheme = resolveStartupTheme(savedTheme)

  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false

    root.classList.remove('dark', 'white')
    if (resolvedTheme === 'dark') root.classList.add('dark')
    if (resolvedTheme === 'white') root.classList.add('white')
    root.style.colorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        applyToRoot()
      },
      { once: true }
    )
  }
}
