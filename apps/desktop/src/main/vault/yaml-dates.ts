/**
 * YAML dates as a vault file spells them.
 *
 * js-yaml reads `due: 2026-10-07` as a Date, and the index keeps that Date as
 * its JSON text, quotes included (`"2026-10-07T00:00:00.000Z"`). Replies and
 * writes use the file's spelling instead, so a date an agent reads can go back
 * through a write unchanged.
 *
 * @module vault/yaml-dates
 */

const YAML_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/
const INDEX_DATE = /^"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/
const MIDNIGHT = 'T00:00:00.000Z'

/** `2026-10-07` for a date at UTC midnight, else the ISO timestamp. */
export function spellYamlDate(date: Date): string {
  const iso = date.toISOString()
  return iso.endsWith(MIDNIGHT) ? iso.slice(0, -MIDNIGHT.length) : iso
}

/** The date a string spells as YAML or as the index's JSON text of a date, else null. */
export function parseYamlDate(value: string): Date | null {
  const text = INDEX_DATE.test(value) ? value.slice(1, -1) : value
  if (!YAML_DATE.test(text)) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

/** A property value with a YAML date, or the index text of one, spelled as the file spells it. */
export function fileSpelling(value: unknown): unknown {
  if (value instanceof Date) return spellYamlDate(value)
  if (typeof value === 'string' && INDEX_DATE.test(value)) {
    return spellYamlDate(new Date(value.slice(1, -1)))
  }
  return value
}

export function fileSpelledProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [name, fileSpelling(value)])
  )
}
