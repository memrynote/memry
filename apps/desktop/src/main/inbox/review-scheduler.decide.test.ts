import { describe, it, expect } from 'vitest'
import { decideReviewNotification, localDateString } from './review-scheduler'

// Local Date built from local Y/M/D h:m — no UTC parsing.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 0, 0)

const base = {
  enabled: true,
  target: '18:00',
  now: at(2026, 7, 17, 18, 0),
  lastNotifiedDate: null as string | null,
  inboxCount: 3
}

describe('decideReviewNotification', () => {
  it('fires exactly at target when eligible', () => {
    const r = decideReviewNotification(base)
    expect(r.notify).toBe(true)
    expect(r.nextLastNotifiedDate).toBe('2026-07-17')
  })

  it('catches up when opened after target same day (#1)', () => {
    const r = decideReviewNotification({ ...base, now: at(2026, 7, 17, 21, 0) })
    expect(r.notify).toBe(true)
  })

  it('does not fire before target (#exact-time)', () => {
    const r = decideReviewNotification({ ...base, now: at(2026, 7, 17, 17, 59) })
    expect(r.notify).toBe(false)
    expect(r.nextLastNotifiedDate).toBeNull()
  })

  it('does not catch up across midnight for a late-night target (#2)', () => {
    const r = decideReviewNotification({
      ...base,
      target: '23:00',
      now: at(2026, 7, 18, 8, 0)
    })
    expect(r.notify).toBe(false)
  })

  it('is silent when already fired today (#5, once/day)', () => {
    const r = decideReviewNotification({ ...base, lastNotifiedDate: '2026-07-17' })
    expect(r.notify).toBe(false)
    expect(r.nextLastNotifiedDate).toBe('2026-07-17')
  })

  it('fires next tick when items appear after target (#3)', () => {
    const r = decideReviewNotification({
      ...base,
      now: at(2026, 7, 17, 19, 3),
      lastNotifiedDate: null,
      inboxCount: 2
    })
    expect(r.notify).toBe(true)
  })

  it('fires for an earlier already-passed time not yet fired (#6)', () => {
    const r = decideReviewNotification({
      ...base,
      target: '16:00',
      now: at(2026, 7, 17, 17, 0)
    })
    expect(r.notify).toBe(true)
  })

  it('is silent when disabled (#8)', () => {
    expect(decideReviewNotification({ ...base, enabled: false }).notify).toBe(false)
  })

  it('is silent when inbox is empty (#17/#18)', () => {
    expect(decideReviewNotification({ ...base, inboxCount: 0 }).notify).toBe(false)
  })

  it('is silent for an invalid target', () => {
    expect(decideReviewNotification({ ...base, target: '6pm' }).notify).toBe(false)
  })

  it('re-eligible the next day (#19)', () => {
    const r = decideReviewNotification({
      ...base,
      now: at(2026, 7, 18, 18, 0),
      lastNotifiedDate: '2026-07-17'
    })
    expect(r.notify).toBe(true)
    expect(r.nextLastNotifiedDate).toBe('2026-07-18')
  })

  it('localDateString uses local Y/M/D (not UTC)', () => {
    expect(localDateString(at(2026, 7, 17, 23, 30))).toBe('2026-07-17')
  })
})
