/**
 * Which template a journal day starts from, and what applying it writes.
 *
 * Pure: no clock and no locale. The locale-formatted strings (`{{date}}`
 * without a pattern, `{{time}}`, `{{day-of-week}}`) are formatted by each
 * shell (desktop `Intl`, iOS `Foundation`) and passed in; this module does the
 * substitution, which is what both platforms must agree on (spec
 * 005-journal D4). Moved from `lib/journal-template-resolution.ts` and
 * `hooks/use-journal-entry.ts` so the iOS core is held to it by the
 * `journal.json` vectors.
 *
 * @module journal/templates
 */

export interface JournalTemplateSettings {
  defaultTemplate: string | null
  weekdayTemplates?: Record<string, string | null>
}

/** Sunday-first, matching JS `getDay()`. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

/** Weekday of a `YYYY-MM-DD` calendar key, 0 = Sunday. Time-zone free. */
export function weekdayOf(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Resolve the template id for `isoDate` (`YYYY-MM-DD`).
 *
 * Templates are bound to the *absolute* weekday, never to a position within the
 * week: the first-day-of-week preference only reorders the settings rows.
 * A `null` or empty weekday entry falls back to the default, like an absent one.
 */
export function resolveJournalTemplateId(
  settings: JournalTemplateSettings,
  isoDate: string
): string | null {
  const perDay = settings.weekdayTemplates?.[String(weekdayOf(isoDate))]
  if (perDay) return perDay
  return settings.defaultTemplate ?? null
}

/**
 * The seven weekdays in display order for a first-day-of-week preference.
 * `weekStartsOn` is 0 (Sunday) or 1 (Monday).
 */
export function orderedWeekdays(weekStartsOn: 0 | 1): number[] {
  return WEEKDAYS.map((day) => (day + weekStartsOn) % 7)
}

/** The strings a shell formats for the day being seeded, in its own locale. */
export interface JournalTemplateFormatted {
  /** `{{date}}` without a pattern: weekday, month, day and year, long form. */
  longDate: string
  /** `{{time}}`: the current time, hour and minutes. */
  time: string
  /** `{{day-of-week}}`: the long weekday name of the day. */
  dayOfWeek: string
}

/** A template's seedable parts. */
export interface JournalTemplateSource {
  content: string
  tags: readonly string[]
  properties: ReadonlyArray<{ name: string; value: unknown }>
}

/** What a seeded day is created with. */
export interface AppliedJournalTemplate {
  content: string
  tags: string[]
  properties: Record<string, unknown>
}

/** `{{date:FORMAT}}`: `YYYY`, `MM` and `DD` replaced from the calendar key. */
export function formatDatePattern(isoDate: string, pattern: string): string {
  const [year, month, day] = isoDate.split('-')
  return pattern.replace(/YYYY/g, year).replace(/MM/g, month).replace(/DD/g, day)
}

/**
 * Substitute a template's tokens for `isoDate` and copy its tags and
 * properties (`name → value`; a later entry with the same name wins).
 */
export function applyJournalTemplate(
  template: JournalTemplateSource,
  isoDate: string,
  formatted: JournalTemplateFormatted
): AppliedJournalTemplate {
  const content = template.content
    .replace(/\{\{title\}\}/g, isoDate)
    .replace(/\{\{date(?::([^}]+))?\}\}/g, (_match, pattern: string | undefined) =>
      pattern ? formatDatePattern(isoDate, pattern) : formatted.longDate
    )
    .replace(/\{\{time\}\}/g, formatted.time)
    .replace(/\{\{day-of-week\}\}/g, formatted.dayOfWeek)

  const properties: Record<string, unknown> = {}
  for (const property of template.properties) {
    properties[property.name] = property.value
  }

  return { content, tags: [...template.tags], properties }
}
