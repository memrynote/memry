import {
  applyColorTheme,
  COLOR_THEME_STORAGE_KEY,
  parseThemeCustomization
} from '@memry/contracts/color-themes'

/**
 * Paints the color theme cached by the renderer on the previous run before the
 * first frame. Without it a themed install flashes the built-in palette on
 * every launch until settings load. No synchronous-IPC fallback like the
 * light/dark theme's: a first launch with nothing cached is the built-in
 * palette, which the renderer corrects as soon as settings arrive.
 */
export function applyStartupColorTheme(): void {
  let custom: ReturnType<typeof parseThemeCustomization> = null
  try {
    const cached = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)
    if (cached) custom = parseThemeCustomization(JSON.parse(cached))
  } catch {
    // Unavailable storage or a corrupt entry: the renderer repaints on load
  }
  if (!custom) return
  const resolved = custom

  const apply = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    applyColorTheme(root, resolved)
    return true
  }

  if (!apply()) {
    window.addEventListener('DOMContentLoaded', () => void apply(), { once: true })
  }
}
