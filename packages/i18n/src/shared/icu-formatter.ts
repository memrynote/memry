import { IntlMessageFormat } from 'intl-messageformat'

/**
 * i18next i18nFormat plugin that uses intl-messageformat (ICU).
 *
 * Replaces the published `i18next-icu` package, whose ESM bundle does
 * `import IntlMessageFormat from 'intl-messageformat'`. In pure ESM,
 * intl-messageformat (10.x) exports the constructor as a NAMED export,
 * so the default-import resolves to the module namespace object — and
 * `new IntlMessageFormat(...)` throws "is not a constructor". This
 * custom plugin uses the correct named import.
 *
 * The plugin contract is i18next's i18nFormat module type:
 * - static `type = 'i18nFormat'` so i18next.use() routes it correctly
 * - instance `parse(res, options, lng, ns, key, info)` returns the
 *   formatted string (or the raw `res` on parse error).
 * - instance `addLookupKeys(finalKeys, ...)` is required by i18next's
 *   resolver pass even though we add nothing to it.
 */
export class IcuFormatter {
  static type: 'i18nFormat' = 'i18nFormat'
  type: 'i18nFormat' = 'i18nFormat'

  private cache = new Map<string, IntlMessageFormat>()

  init(): void {
    // No init needed; cache is per-instance.
  }

  parse(res: unknown, options: Record<string, unknown>, lng: string, ns: string, key: string): string {
    if (typeof res !== 'string') return String(res)
    const cacheKey = `${lng}::${ns}::${key}`
    let fc = this.cache.get(cacheKey)
    try {
      if (!fc) {
        fc = new IntlMessageFormat(res, lng, undefined, { ignoreTag: true })
        this.cache.set(cacheKey, fc)
      }
      return fc.format(options) as string
    } catch {
      // On parse failure, return raw template so consumers see the bug
      // instead of a silent empty string.
      return res
    }
  }

  addLookupKeys(finalKeys: string[]): string[] {
    return finalKeys
  }
}
