import { describe, it, expect } from 'vitest'
import {
  DATE_MENTION_TOKEN_REGEX,
  serializeDateMentionToken,
  parseDateMentionToken,
  salvageDateMentionToken,
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

/**
 * The writer that shipped before the alphabet closed: plain base64url, `-` and
 * `_` included. Every token in a real vault was written by this, so it doubles
 * as the compatibility fixture and as the byte-identity oracle below.
 */
const encode = (obj: unknown): string =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const payload = (token: string): string => token.replace(/^\(\(date:|\)\)$/g, '')

/** A base64url run as a markdown escaper would have left it. */
const markdownEscaped = (run: string): string =>
  [...run].map((c) => (c === '_' || c === '-' ? `\\${c}` : c)).join('')

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

describe('the on-disk alphabet is closed and markdown-inert', () => {
  // `?` is the shortest input that drives base64 onto its 63rd symbol, which is
  // where base64url puts `_` — the one character remark-stringify escapes
  // unconditionally in phrasing content. Nothing in a real payload reaches it,
  // which is exactly why the alphabet has to be closed by construction rather
  // than left to what the fields happen to contain.
  const forced: DateMentionData = { ...base, anchorId: 'dm_0?x' }

  it('never emits a character a markdown writer would escape', () => {
    expect(encode(forced)).toMatch(/_/)
    expect(payload(serializeDateMentionToken(forced))).toMatch(/^[A-Za-z0-9,;]+$/)
  })

  it('round-trips a payload that forced the odd base64 symbols', () => {
    const token = serializeDateMentionToken(forced)
    const [m] = [...token.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(parseDateMentionToken(m[1])).toEqual(forced)
  })

  it('writes the bytes the old writer wrote, for every payload a note can hold', () => {
    // Byte identity is the compatibility contract: the vault write-back compares
    // bytes, so a token that re-serialized differently would rewrite every note
    // holding a date pill. `anchorId` is the only free field and it is
    // `dm_<uuid>`, so no payload reaches `+`/`/` and both writers agree.
    for (let i = 0; i < 200; i++) {
      const data: DateMentionData = {
        anchorId: `dm_${crypto.randomUUID()}`,
        dateISO: new Date(Date.UTC(2026, i % 12, (i % 27) + 1, i % 24, i % 60)).toISOString(),
        hasTime: i % 2 === 0,
        dateFormat: i % 3 === 0 ? 'full' : 'relative',
        remind: (['none', 'at', '5m', '30m', '1h', '2h', '1d', '2d', '1w'] as const)[i % 9],
        timeFormat: (['system', '12h', '24h'] as const)[i % 3]
      }
      expect(serializeDateMentionToken(data)).toBe(`((date:${encode(data)}))`)
    }
  })
})

describe('tolerating tokens already on disk', () => {
  const legacy: DateMentionData = { ...base, anchorId: 'dm_0?x' }

  it('parses a base64url token written before the alphabet closed', () => {
    const written = encode(legacy)
    expect(written).toMatch(/[-_]/)
    expect(parseDateMentionToken(written)).toEqual(legacy)
  })

  it('heals a token a markdown escaper backslashed', () => {
    // What the issue reports: `\` lands inside the run, the strict class stops
    // matching, and the pill is left on the page as literal text.
    const escaped = markdownEscaped(encode(legacy))
    expect(escaped).toContain('\\')
    expect(parseDateMentionToken(escaped)).toEqual(legacy)
  })

  it('matches escaped and legacy shapes with the token regex', () => {
    const escaped = `((date:${markdownEscaped(encode(legacy))}))`
    const matches = [...`due ${escaped} today`.matchAll(DATE_MENTION_TOKEN_REGEX)]
    expect(matches).toHaveLength(1)
    expect(parseDateMentionToken(matches[0][1])?.anchorId).toBe('dm_0?x')
  })
})

describe('salvageDateMentionToken', () => {
  const preEnum = {
    anchorId: 'dm_old',
    dateISO: '2026-06-20T09:00:00.000Z',
    hasTime: true,
    dateFormat: 'full',
    remind: true,
    lead: '1h'
  }

  it('recovers the date from a token the parser refuses', () => {
    // The parser's graceful null is unchanged — the salvage sits beside it, so
    // a pre-enum token shows the date it was rather than its own base64.
    expect(parseDateMentionToken(encode(preEnum))).toBeNull()
    expect(salvageDateMentionToken(encode(preEnum))).toEqual({
      anchorId: 'dm_old',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: true,
      dateFormat: 'full',
      remind: 'none',
      timeFormat: 'system'
    })
  })

  it('returns null when no date survives', () => {
    expect(salvageDateMentionToken('not-json')).toBeNull()
    expect(salvageDateMentionToken(encode({ anchorId: 'dm_x' }))).toBeNull()
    expect(salvageDateMentionToken(encode({ anchorId: 'dm_x', dateISO: 'whenever' }))).toBeNull()
    expect(salvageDateMentionToken(encode({ dateISO: base.dateISO }))).toBeNull()
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
