/**
 * Journal template settings keys and weekday-map helpers.
 *
 * A leaf module on purpose: the IPC settings handlers and the sync settings
 * item-handler both need these, and importing them from ipc/settings-handlers
 * would close a cycle (sync/item-handlers -> ipc/settings-handlers ->
 * settings/runtime-effects -> sync/local-mutations -> sync/item-handlers).
 *
 * @module settings/journal-template-keys
 */

/** Fallback template applied to any day without its own weekday entry. */
export const JOURNAL_DEFAULT_TEMPLATE_KEY = 'journal.defaultTemplate'

/** JSON object keyed by JS `getDay()` ("0" = Sunday … "6" = Saturday). */
export const JOURNAL_WEEKDAY_TEMPLATES_KEY = 'journal.weekdayTemplates'

/**
 * Template id per weekday, or `null` for "fall back to the default template".
 *
 * A cleared day keeps a `null` entry rather than dropping the key: the entry is
 * what the per-day field clock (`journal.weekdayTemplates.<day>`) refers to, so
 * removing it would leave the clear unable to win against a stale remote value.
 */
export type WeekdayTemplateMap = Record<string, string | null>

/** Days are addressed by absolute weekday, never by position within the week. */
export function isWeekdayKey(key: string): boolean {
  return /^[0-6]$/.test(key)
}

/**
 * Parse a stored weekday map, dropping anything that is not a `"0".."6"` key
 * mapped to a template id or null. Corrupt or partially-written JSON degrades
 * to an empty map rather than throwing: the caller's next write repairs it, and
 * a broken row must not take the whole journal settings read down with it.
 */
export function parseWeekdayTemplateMap(raw: string | null | undefined): WeekdayTemplateMap {
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }

  return sanitizeWeekdayTemplateMap(parsed)
}

/** Keep only well-formed `"0".."6"` → `string | null` pairs. */
export function sanitizeWeekdayTemplateMap(value: unknown): WeekdayTemplateMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}

  const result: WeekdayTemplateMap = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isWeekdayKey(key)) continue
    if (entry === null) {
      result[key] = null
    } else if (typeof entry === 'string') {
      result[key] = entry
    }
  }
  return result
}
