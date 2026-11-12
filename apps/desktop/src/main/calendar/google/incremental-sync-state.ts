import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'

/**
 * What a Google calendar's sync token has proven, kept in `calendar_sources.metadata`.
 *
 * Google answers an incremental events.list on a public holiday calendar with
 * 410 Gone, for a token it issued with the full listing a pass earlier (#4018).
 * Without a record of that, every pass pays for a refused request and a full
 * pull. The record is two optional keys, and a row without them (every row an
 * older build wrote) reads as an ordinary calendar:
 *
 * - `cursorUnproven`: the stored token came from a full listing and no
 *   incremental request has used it yet.
 * - `incrementalUnsupportedUntil`: Google refused such a token. Until this
 *   instant the calendar is pulled in full each pass and no token is kept.
 *
 * A token that worked and is later refused is an ordinary expiry, which Google
 * documents as a reason to re-sync in full, and does not suspend anything.
 */
const UNSUPPORTED_RETRY_MS = 7 * 24 * 60 * 60 * 1000

type Metadata = CalendarSource['metadata']

export function isIncrementalSuspended(metadata: Metadata, now: string): boolean {
  const until = metadata?.incrementalUnsupportedUntil
  return typeof until === 'string' && until > now
}

function withKeys(metadata: Metadata, keys: Record<string, unknown>): Metadata {
  const next: Record<string, unknown> = { ...metadata }
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return Object.keys(next).length > 0 ? next : null
}

/** After a pass that listed the calendar without a token: whatever it stored is untried. */
export function afterFullListing(metadata: Metadata, storedCursor: boolean): Metadata {
  return withKeys(metadata, {
    cursorUnproven: storedCursor ? true : undefined,
    incrementalUnsupportedUntil: undefined
  })
}

/** After an incremental pass that Google answered with a new token. */
export function afterIncrementalPass(metadata: Metadata): Metadata {
  return withKeys(metadata, { cursorUnproven: undefined })
}

/**
 * After Google refused the stored token. `unsupported` is true when that token
 * had never worked, which is how a holiday calendar behaves.
 */
export function afterCursorRefused(
  metadata: Metadata,
  now: string
): { metadata: Metadata; unsupported: boolean } {
  const unsupported = metadata?.cursorUnproven === true
  return {
    unsupported,
    metadata: withKeys(metadata, {
      cursorUnproven: undefined,
      incrementalUnsupportedUntil: unsupported
        ? new Date(Date.parse(now) + UNSUPPORTED_RETRY_MS).toISOString()
        : undefined
    })
  }
}
