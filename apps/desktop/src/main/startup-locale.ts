/**
 * Pure helper for picking a fresh install's UI language from the OS locale.
 *
 * Kept free of Electron and store imports so the tag mapping can be unit tested
 * without an app instance. `index.ts` feeds it `app.getLocale()`, owns the
 * first-run gate, and persists the result so the choice is made once.
 */

import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'

/**
 * OS tags whose supported locale cannot be reached by dropping subtags.
 *
 * Chinese: `zh` alone carries no script, so the script/region subtag decides
 * Simplified vs Traditional. Bare `zh` follows CLDR's likely-subtags default
 * (`zh` → `zh-Hans`) rather than dropping to English.
 *
 * Norwegian: macOS and Windows report Bokmål/Nynorsk as `nb`/`nn`, never as
 * `no`, so without these the supported `no` locale is unreachable by detection.
 *
 * Keys are lowercased because BCP-47 tags are case-insensitive.
 */
const LOCALE_ALIASES: Record<string, string> = {
  zh: 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-tw': 'zh-TW',
  'zh-hk': 'zh-TW',
  nb: 'no',
  nn: 'no'
}

/**
 * Map an OS locale tag (`app.getLocale()`) onto a supported UI locale.
 *
 * Region variants collapse onto their base language (`de-AT` → `de`,
 * `pt-BR` → `pt`, `en-GB` → `en`, `fr-CA` → `fr`), while the aliases above pin
 * the right script (`zh`/`zh-Hans`/`zh-CN`/`zh-SG` → `zh-CN`,
 * `zh-Hant`/`zh-TW`/`zh-HK` → `zh-TW`) and reach locales the OS never names
 * directly (`nb-NO`/`nn-NO` → `no`). Anything unrecognised — including an empty
 * or missing tag — resolves to `FALLBACK_LOCALE`.
 */
export function resolveOsLocale(osLocale: string | null | undefined): Locale {
  const normalized = (osLocale ?? '').trim().replace(/_/g, '-').toLowerCase()
  if (!normalized) return FALLBACK_LOCALE

  // Walk from the most specific tag to the least (`zh-hans-cn` → `zh-hans` →
  // `zh`, `de-at` → `de`) and take the first hit, so a script subtag still wins
  // over the bare language.
  const subtags = normalized.split('-')
  for (let end = subtags.length; end > 0; end--) {
    const candidate = subtags.slice(0, end).join('-')
    // LocaleSchema is the single source of truth for "supported", so every
    // candidate is validated through it rather than against a second list.
    const parsed = LocaleSchema.safeParse(LOCALE_ALIASES[candidate] ?? candidate)
    if (parsed.success) return parsed.data
  }

  return FALLBACK_LOCALE
}
