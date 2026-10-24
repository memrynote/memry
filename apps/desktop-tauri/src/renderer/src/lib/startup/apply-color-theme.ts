import {
  applyColorTheme,
  COLOR_THEME_STORAGE_KEY,
  parseThemeCustomization
} from '@memry/contracts/color-themes'
import { readStartupState } from './state'

/**
 * Paints the color theme before the first frame, so a themed install does not flash the
 * built-in palette on every launch. The startup state wins; the cache the renderer wrote on
 * the previous run covers a state that carries none.
 */
export function applyStartupColorTheme(): void {
  let custom: ReturnType<typeof parseThemeCustomization> = null
  try {
    const fromState = readStartupState()?.colorTheme
    if (fromState) custom = parseThemeCustomization(fromState)
    if (!custom) {
      const cached = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY)
      if (cached) custom = parseThemeCustomization(JSON.parse(cached))
    }
  } catch {
    // Unavailable storage or a corrupt entry: the renderer repaints once settings load
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
