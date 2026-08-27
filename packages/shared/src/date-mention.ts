/**
 * Durable token for inline date mentions. The renderer pill serializes its
 * props to `((date:<base64-json>))` so the date survives the markdown
 * round-trip as a single text node, and the main process derives reminder
 * rows by parsing the same token out of the note's raw markdown. This module
 * is the single source of truth for the format — imported by both sides.
 */

export type RemindOffset =
  'none' | 'at' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h' | '1d' | '2d' | '1w'

export type DateMentionDateFormat = 'relative' | 'full'

// Per-block clock format. 'system' inherits the app's general time-format
// setting (the default); '12h'/'24h' override it for this pill only.
export type DateMentionTimeFormat = 'system' | '12h' | '24h'

export interface DateMentionData {
  anchorId: string
  dateISO: string
  hasTime: boolean
  dateFormat: DateMentionDateFormat
  remind: RemindOffset
  timeFormat: DateMentionTimeFormat
}

/**
 * What a token may contain on disk. Writers emit the closed alphabet below;
 * the class is wider so a token that already picked up base64url's `-`/`_` — or
 * a stray `\` from a markdown escaper — still matches and is healed on read.
 */
export const DATE_MENTION_TOKEN_REGEX = /\(\(date:([A-Za-z0-9,;_\\-]+)\)\)/g

const REMIND_OFFSETS: ReadonlyArray<RemindOffset> = [
  'none',
  'at',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '2h',
  '1d',
  '2d',
  '1w'
]

// Sub-day offsets subtract a fixed duration from the event instant.
const SUBDAY_MS: Record<string, number> = {
  at: 0,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000
}

// Day-level offsets fire at 09:00 local-in-zone, N days before the event date.
const DAY_OFFSET: Record<string, number> = {
  '1d': 1,
  '2d': 2,
  '1w': 7
}

/**
 * base64 over a closed, markdown-inert alphabet: `A-Za-z0-9` plus `,` and `;`
 * in place of base64url's `-` and `_`.
 *
 * The two odd base64 symbols are the only characters an encoder can emit, so
 * they are the only ones a markdown writer could ever get hold of — and `_`
 * opens emphasis, which puts it on remark-stringify's unconditional escape list
 * for phrasing content. `,` and `;` appear on no escape list and start no
 * markdown construct, so a token is inert by construction rather than by luck.
 *
 * Existing vault bytes are untouched: the payload is printable-ASCII JSON, and
 * base64 only reaches `+`/`/` for input containing `>`, `?` or `~`. No field can
 * hold one (`dm_<uuid>` anchors, ISO dates, closed enums), so every token
 * written before this change re-encodes to the same bytes and no note is
 * rewritten by the write-back byte compare.
 */
function encodeTokenPayload(s: string): string {
  // btoa/atob exist in both renderer (browser) and Electron main (Node 20+).
  return btoa(s).replace(/\+/g, ',').replace(/\//g, ';').replace(/=+$/, '')
}

function decodeTokenPayload(s: string): string {
  // `\` can only be an escaper's, never an encoder's. Both alphabets decode:
  // `-`/`,` were `+`, `_`/`;` were `/`.
  const base64 = s.replace(/\\/g, '').replace(/[-,]/g, '+').replace(/[_;]/g, '/')
  return atob(base64)
}

function decodeTokenObject(encoded: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(decodeTokenPayload(encoded)) as unknown
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function serializeDateMentionToken(data: DateMentionData): string {
  return `((date:${encodeTokenPayload(JSON.stringify(data))}))`
}

export function parseDateMentionToken(encoded: string): DateMentionData | null {
  const obj = decodeTokenObject(encoded)
  if (!obj) return null

  // Strict on the load-bearing fields; old tokens carried boolean `remind`
  // + `lead`, both of which fail the enum/string checks below → null (a
  // graceful drop; callers already skip null).
  if (
    typeof obj.anchorId !== 'string' ||
    typeof obj.dateISO !== 'string' ||
    typeof obj.hasTime !== 'boolean' ||
    typeof obj.remind !== 'string' ||
    !REMIND_OFFSETS.includes(obj.remind as RemindOffset)
  ) {
    return null
  }
  // Default the cosmetic fields so slightly-old or hand-authored tokens still
  // render. timeFormat falls back to 'system' (inherit general settings).
  const dateFormat: DateMentionDateFormat = obj.dateFormat === 'full' ? 'full' : 'relative'
  const timeFormat: DateMentionTimeFormat =
    obj.timeFormat === '12h' || obj.timeFormat === '24h' ? obj.timeFormat : 'system'
  return {
    anchorId: obj.anchorId,
    dateISO: obj.dateISO,
    hasTime: obj.hasTime,
    dateFormat,
    remind: obj.remind as RemindOffset,
    timeFormat
  }
}

/**
 * Best-effort recovery from a token `parseDateMentionToken` refused.
 *
 * A pre-`remind`-enum token fails that check on `remind` alone, and until now
 * it stayed on the page as its own base64 — a dense, unreadable run where a
 * date used to be, which is the half of #1845 the reporter could not work
 * around. The date itself is right there in the payload, so the pill degrades
 * to a plain, readable date rather than a blob. The reminder is not restored:
 * those tokens have armed nothing since the enum landed, so `none` is what they
 * already meant.
 *
 * Returns null when the payload carries no usable date. Those bytes are left
 * exactly as the user's disk has them — an unreadable token beats a destroyed
 * one.
 */
export function salvageDateMentionToken(encoded: string): DateMentionData | null {
  const obj = decodeTokenObject(encoded)
  if (!obj) return null
  if (typeof obj.anchorId !== 'string' || !obj.anchorId) return null
  if (typeof obj.dateISO !== 'string' || Number.isNaN(Date.parse(obj.dateISO))) return null

  return {
    anchorId: obj.anchorId,
    dateISO: obj.dateISO,
    hasTime: obj.hasTime === true,
    dateFormat: obj.dateFormat === 'full' ? 'full' : 'relative',
    remind: 'none',
    timeFormat: obj.timeFormat === '12h' || obj.timeFormat === '24h' ? obj.timeFormat : 'system'
  }
}

// Reminders always resolve in the host's local (OS) timezone: derivation runs
// per-device, so each device fires the reminder at its own local 09:00 / event
// time. Day-level offsets fire at 09:00 local; sub-day offsets subtract from the
// event instant (09:00 local when the event has no explicit time).
export function computeRemindAt(
  data: Pick<DateMentionData, 'dateISO' | 'hasTime' | 'remind'>
): string | null {
  const { dateISO, hasTime, remind } = data
  if (remind === 'none') return null

  const subday = SUBDAY_MS[remind]
  if (subday !== undefined) {
    let eventMs: number
    if (hasTime) {
      eventMs = Date.parse(dateISO)
    } else {
      const d = new Date(dateISO)
      d.setHours(9, 0, 0, 0)
      eventMs = d.getTime()
    }
    return new Date(eventMs - subday).toISOString()
  }

  // Day-level: 09:00 local, N calendar days before the event's local date.
  const n = DAY_OFFSET[remind]
  const d = new Date(dateISO)
  d.setHours(9, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d.toISOString()
}
