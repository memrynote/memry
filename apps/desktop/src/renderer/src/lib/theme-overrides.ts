/**
 * Inline application of custom-theme variable overrides on a root element,
 * plus the localStorage cache the preload script reads for a FOUC-free first
 * paint (`applyStartupTheme`).
 *
 * @module lib/theme-overrides
 */

import { sanitizeThemeVariables } from '@memry/contracts/themes-api'

export const CUSTOM_THEME_OVERRIDES_STORAGE_KEY = 'memry-custom-theme-overrides'

const APPLIED_ATTR = 'data-custom-theme-vars'

function appliedVars(root: HTMLElement): string[] {
  const raw = root.getAttribute(APPLIED_ATTR)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

export function applyCustomThemeVariables(
  root: HTMLElement,
  variables: Record<string, string>
): void {
  const next = sanitizeThemeVariables(variables)
  const nextKeys = Object.keys(next)

  for (const key of appliedVars(root)) {
    if (!(key in next)) {
      root.style.removeProperty(key)
    }
  }
  for (const [key, value] of Object.entries(next)) {
    root.style.setProperty(key, value)
  }

  if (nextKeys.length > 0) {
    root.setAttribute(APPLIED_ATTR, JSON.stringify(nextKeys))
  } else {
    root.removeAttribute(APPLIED_ATTR)
  }
}

export function clearCustomThemeVariables(root: HTMLElement): void {
  applyCustomThemeVariables(root, {})
}

export function readCachedThemeOverrides(): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEME_OVERRIDES_STORAGE_KEY)
    if (!raw) return null
    const sanitized = sanitizeThemeVariables(JSON.parse(raw))
    return Object.keys(sanitized).length > 0 ? sanitized : null
  } catch {
    return null
  }
}

export function writeCachedThemeOverrides(variables: Record<string, string>): void {
  try {
    window.localStorage.setItem(
      CUSTOM_THEME_OVERRIDES_STORAGE_KEY,
      JSON.stringify(sanitizeThemeVariables(variables))
    )
  } catch {
    // localStorage unavailable — startup will fall back to the IPC path
  }
}

export function clearCachedThemeOverrides(): void {
  try {
    window.localStorage.removeItem(CUSTOM_THEME_OVERRIDES_STORAGE_KEY)
  } catch {
    // ignore
  }
}
