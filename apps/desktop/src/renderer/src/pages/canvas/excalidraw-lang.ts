/**
 * Maps a Memry locale to the closest Excalidraw langCode.
 *
 * Excalidraw's own toolbar/menus/dialogs are translated by its bundled
 * translations, selected via the langCode prop. This is independent of
 * Memry's i18n and of `i18n:check` (which only gates Memry's own strings) —
 * we do not translate Excalidraw's internal UI ourselves.
 */

export interface ExcalidrawLanguage {
  code: string
}

/**
 * Picks the closest match from Excalidraw's `languages` list for a Memry
 * locale ('en', 'tr', 'zh-CN', ...). Excalidraw codes are mostly
 * region-qualified ('tr-TR', 'de-DE'); Memry locales are mostly bare.
 * Falls back to `fallback` (Excalidraw's defaultLang.code) when nothing fits.
 */
export function pickExcalidrawLangCode(
  locale: string | undefined,
  available: readonly ExcalidrawLanguage[],
  fallback: string
): string {
  if (!locale) {
    return fallback
  }
  const normalized = locale.toLowerCase()
  const exact = available.find((lang) => lang.code.toLowerCase() === normalized)
  if (exact) {
    return exact.code
  }
  const base = normalized.split('-')[0]
  const baseExact = available.find((lang) => lang.code.toLowerCase() === base)
  if (baseExact) {
    return baseExact.code
  }
  const regional = available.find((lang) => lang.code.toLowerCase().startsWith(`${base}-`))
  if (regional) {
    return regional.code
  }
  return fallback
}
