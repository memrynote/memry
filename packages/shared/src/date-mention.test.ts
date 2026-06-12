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
  remind: true,
  lead: '1h'
}

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
    const b = serializeDateMentionToken({ ...base, anchorId: 'dm_def', remind: false, lead: 'at' })
    const all = [...`${a} mid ${b}`.matchAll(DATE_MENTION_TOKEN_REGEX)].map((m) =>
      parseDateMentionToken(m[1])
    )
    expect(all.map((d) => d?.anchorId)).toEqual(['dm_abc123', 'dm_def'])
    expect(all[1]?.remind).toBe(false)
  })

  it('returns null on malformed payload', () => {
    expect(parseDateMentionToken('not-json')).toBeNull()
  })

  it('returns null when a field is the wrong type or lead is invalid', () => {
    const encode = (obj: unknown) =>
      btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(parseDateMentionToken(encode({ ...base, lead: '2h' }))).toBeNull()
    expect(parseDateMentionToken(encode({ ...base, hasTime: 'yes' }))).toBeNull()
    expect(parseDateMentionToken(encode({ dateISO: base.dateISO }))).toBeNull()
  })

  it('round-trips a bare date (hasTime:false, remind:false)', () => {
    const bare = { ...base, hasTime: false, remind: false, lead: 'at' as const }
    const token = serializeDateMentionToken(bare)
    const [m] = [...token.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(parseDateMentionToken(m[1])).toEqual(bare)
  })

  it('computeRemindAt subtracts the lead offset', () => {
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', 'at')).toBe('2026-06-20T09:00:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '5m')).toBe('2026-06-20T08:55:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '1h')).toBe('2026-06-20T08:00:00.000Z')
    expect(computeRemindAt('2026-06-20T09:00:00.000Z', '1d')).toBe('2026-06-19T09:00:00.000Z')
  })
})
