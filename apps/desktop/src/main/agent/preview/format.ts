import type { ChangePreviewField } from '@memry/contracts/ipc-agent'

/**
 * The read handles hand several item types back as `unknown`, and a preview is
 * not the place to introduce a schema for each one: every value here is headed
 * for a display string, and {@link displayValue} already copes with whatever
 * type a column turns out to hold. Reading loosely also means a column renamed
 * upstream costs one missing row rather than a thrown preview.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Turn a stored value into something a field row can print, or `null` for
 * "not set".
 *
 * `null` is not the same as the empty string here and the distinction is the
 * point: a task with no due date must read as unset, not as a blank the user
 * squints at. Booleans become the literal strings `true` and `false` because
 * main has no locale — the renderer maps those two tokens to words.
 */
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) {
    const parts = value.map((entry) => displayValue(entry)).filter((entry) => entry !== null)
    return parts.length > 0 ? parts.join(', ') : null
  }
  return null
}

/**
 * A field row, or `null` when the write would not actually move this field.
 *
 * Dropping unchanged rows is what keeps the card honest: an agent patch often
 * carries every column it read, and listing the twelve that stay the same
 * beside the one that moves is how a preview stops being read.
 */
export function field(key: string, before: unknown, after: unknown): ChangePreviewField | null {
  const from = displayValue(before)
  const to = displayValue(after)
  if (from === to) return null
  return { key, before: from, after: to }
}

/**
 * A row for a value the caller did not supply. An absent key in a patch means
 * "leave it alone", so it must not be shown as a change to null.
 */
export function optionalField(
  key: string,
  before: unknown,
  after: unknown
): ChangePreviewField | null {
  if (after === undefined) return null
  return field(key, before, after)
}

export function fields(...rows: (ChangePreviewField | null | undefined)[]): ChangePreviewField[] {
  return rows.filter((row): row is ChangePreviewField => Boolean(row))
}

/** How `vault_update_note` and `vault_update_journal_entry` fold new text in. */
export function mergeContent(
  current: string,
  mode: 'append' | 'prepend' | 'replace',
  next: string
): string {
  if (mode === 'replace') return next
  if (!current) return next
  if (!next) return current
  return mode === 'append' ? `${current}\n\n${next}` : `${next}\n\n${current}`
}

export function countWords(text: string): number {
  const matches = text.trim().match(/\S+/g)
  return matches ? matches.length : 0
}

/** First non-empty lines of a body, for the "what would be lost" list. */
export function excerpt(text: string, maxChars = 240): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) return null
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}\u2026`
}
