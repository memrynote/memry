/**
 * Convert ISO-string top-level note DTO timestamp fields shipped by the Rust
 * notes commands back into `Date` instances so renderer code (e.g. note tree
 * sort by `modified.getTime()`) keeps working without per-call-site changes.
 *
 * The mock router returns Date objects directly, so we no-op when the field
 * is already a Date. Walks envelopes like `NoteListResponse` and
 * `NoteCreateResponse`, but does not rewrite arbitrary user properties.
 */
const NOTE_DATE_FIELDS = new Set(['created', 'modified'])

export function reviveNoteDates<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((item) => reviveNoteDates(item)) as unknown as T
  }
  if (typeof value !== 'object' || value instanceof Date) return value

  const record = value as Record<string, unknown>
  const shouldReviveDates = isNoteDateCarrier(record)
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (shouldReviveDates && NOTE_DATE_FIELDS.has(key) && typeof raw === 'string') {
      out[key] = new Date(raw)
    } else {
      out[key] = reviveNoteDates(raw)
    }
  }
  return out as T
}

function isNoteDateCarrier(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    (Object.prototype.hasOwnProperty.call(value, 'created') ||
      Object.prototype.hasOwnProperty.call(value, 'modified'))
  )
}

/**
 * Set of `notesService` method names whose responses need the Date revival
 * pass. Methods returning IDs/booleans/positions/etc. are intentionally
 * omitted to keep the adapter free of unnecessary recursion.
 */
export const NOTE_METHODS_WITH_DATES: ReadonlySet<string> = new Set([
  'create',
  'get',
  'getByPath',
  'list',
  'listByFolder',
  'update',
  'rename',
  'move',
  'restoreVersion'
])
