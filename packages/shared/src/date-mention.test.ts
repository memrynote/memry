import { describe, it, expect } from 'vitest'
import {
  DATE_MENTION_TOKEN_REGEX,
  serializeDateMentionToken,
  parseDateMentionToken,
  computeRemindAt,
  type DateMentionData
} from './date-mention'

const base: DateMentionData = {
  anchorId: 'dm_abc123',
  dateISO: '2026-06-20T09:00:00.000Z',
  hasTime: true,
  dateFormat: 'full',
  remind: '1h',
  timeFormat: '24h'
}

const encode = (obj: unknown): string =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('date-mention token', () => {
  it('round-trips through serialize/parse', () => {
    const token = serializeDateMentionToken(base)
    const parsed = parseDateMentionToken(token.replace(/^\(\(date:|\)\)$/g, ''))
    expect(parsed).toEqual(base)
  })

  it('matches the token regex', () => {
    const token = serializeDateMentionToken(base)
    const matches = [...`x ${token} y`.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(matches).toHaveLength(1)
  })

  it('parses every token in a markdown string', () => {
    const a = serializeDateMentionToken(base)
    const b = serializeDateMentionToken({ ...base, anchorId: 'dm_def', remind: 'none' })
    const all = [...`${a} mid ${b}`.matchAll(DATE_MENTION_TOKEN_REGEX)].map((m) =>
      parseDateMentionToken(m[1])
    )
    expect(all.map((d) => d?.anchorId)).toEqual(['dm_abc123', 'dm_def'])
    expect(all[1]?.remind).toBe('none')
  })

  it('returns null on malformed payload', () => {
    expect(parseDateMentionToken('not-json')).toBeNull()
  })

  it('returns null when a required field is the wrong type or remind is invalid', () => {
    expect(parseDateMentionToken(encode({ ...base, remind: 'badvalue' }))).toBeNull()
    expect(parseDateMentionToken(encode({ ...base, hasTime: 'yes' }))).toBeNull()
    expect(parseDateMentionToken(encode({ dateISO: base.dateISO }))).toBeNull()
  })

  it('rejects old-format tokens (boolean remind + lead)', () => {
    const legacy = {
      anchorId: 'dm_old',
      dateISO: base.dateISO,
      hasTime: true,
      remind: true,
      lead: '1h'
    }
    expect(parseDateMentionToken(encode(legacy))).toBeNull()
  })

  it('defaults a missing dateFormat gracefully', () => {
    const partial = {
      anchorId: 'dm_partial',
      dateISO: base.dateISO,
      hasTime: false,
      remind: 'none'
    }
    const parsed = parseDateMentionToken(encode(partial))
    expect(parsed).not.toBeNull()
    expect(parsed?.dateFormat).toBe('relative')
  })

  it('defaults a missing or invalid timeFormat to "system"', () => {
    const missing = {
      anchorId: 'dm_tf_missing',
      dateISO: base.dateISO,
      hasTime: true,
      dateFormat: 'full',
      remind: 'none'
    }
    expect(parseDateMentionToken(encode(missing))?.timeFormat).toBe('system')
    expect(parseDateMentionToken(encode({ ...base, timeFormat: 'bogus' }))?.timeFormat).toBe(
      'system'
    )
  })

  it('round-trips a per-block timeFormat override', () => {
    const token = serializeDateMentionToken({ ...base, timeFormat: '12h' })
    const [m] = [...token.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(parseDateMentionToken(m[1])?.timeFormat).toBe('12h')
  })

  it('round-trips a bare date (hasTime:false, remind:none)', () => {
    const bare: DateMentionData = {
      ...base,
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none'
    }
    const token = serializeDateMentionToken(bare)
    const [m] = [...token.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(parseDateMentionToken(m[1])).toEqual(bare)
  })
})

describe('computeRemindAt (local timezone)', () => {
  // Local date so the wall-clock assertions are timezone-independent.
  const eventNoTime = new Date(2026, 5, 20, 0, 0, 0).toISOString() // 2026-06-20, local

  it('returns null when remind is none', () => {
    expect(computeRemindAt({ dateISO: eventNoTime, hasTime: false, remind: 'none' })).toBeNull()
  })

  it('subtracts sub-day offsets from a timed event instant', () => {
    const d = { dateISO: '2026-06-20T09:00:00.000Z', hasTime: true as const }
    expect(computeRemindAt({ ...d, remind: 'at' })).toBe('2026-06-20T09:00:00.000Z')
    expect(computeRemindAt({ ...d, remind: '5m' })).toBe('2026-06-20T08:55:00.000Z')
    expect(computeRemindAt({ ...d, remind: '30m' })).toBe('2026-06-20T08:30:00.000Z')
    expect(computeRemindAt({ ...d, remind: '1h' })).toBe('2026-06-20T08:00:00.000Z')
    expect(computeRemindAt({ ...d, remind: '2h' })).toBe('2026-06-20T07:00:00.000Z')
  })

  it('uses 09:00 local for sub-day offsets when the event has no time', () => {
    const at = new Date(computeRemindAt({ dateISO: eventNoTime, hasTime: false, remind: 'at' })!)
    expect(at.getHours()).toBe(9)
    expect(at.getMinutes()).toBe(0)
    expect(at.getDate()).toBe(20)

    const before = new Date(
      computeRemindAt({ dateISO: eventNoTime, hasTime: false, remind: '1h' })!
    )
    expect(before.getHours()).toBe(8)
    expect(before.getDate()).toBe(20)
  })

  it('fires day-level offsets at 09:00 local N days before', () => {
    const oneDay = new Date(
      computeRemindAt({ dateISO: eventNoTime, hasTime: false, remind: '1d' })!
    )
    expect(oneDay.getHours()).toBe(9)
    expect(oneDay.getDate()).toBe(19)

    const oneWeek = new Date(
      computeRemindAt({ dateISO: eventNoTime, hasTime: false, remind: '1w' })!
    )
    expect(oneWeek.getHours()).toBe(9)
    expect(oneWeek.getDate()).toBe(13)
  })
})
