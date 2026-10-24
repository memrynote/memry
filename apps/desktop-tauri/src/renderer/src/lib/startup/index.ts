import { applyStartupColorTheme } from './apply-color-theme'
import { applyStartupLocale } from './apply-locale'
import { applyStartupPlatform } from './apply-platform'
import { applyStartupTheme, resolveStartupTheme } from './apply-theme'
import { applyStartupZoom } from './apply-zoom'

/**
 * The sequence of `src/preload/index.ts` in the Electron app: theme (and its cache), color
 * theme, platform, zoom cache, locale. Runs before first paint, from `main.tsx`.
 */
export function applyStartupState(): void {
  applyStartupTheme(resolveStartupTheme())
  applyStartupColorTheme()
  applyStartupPlatform()
  applyStartupZoom()
  applyStartupLocale()
}
