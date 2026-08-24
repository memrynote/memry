import { describe, expect, it, vi } from 'vitest'

import {
  evaluateWriteAccess,
  getClientPolicy,
  toPolicySnapshot,
  type ClientPolicyRow
} from './client-policies'

const row = (overrides: Partial<ClientPolicyRow> = {}): ClientPolicyRow => ({
  platform: 'ios',
  min_write_version: null,
  writes_enabled: 1,
  updated_at: 0,
  ...overrides
})

describe('getClientPolicy', () => {
  it('reads the row for the requested platform', async () => {
    const first = vi.fn().mockResolvedValue(row())
    const bind = vi.fn().mockReturnValue({ first })
    const db = { prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database

    await expect(getClientPolicy(db, 'ios')).resolves.toEqual(row())
    expect(bind).toHaveBeenCalledWith('ios')
  })
})

describe('evaluateWriteAccess', () => {
  it('allows when no policy row exists', () => {
    expect(evaluateWriteAccess(null, '1.0.0')).toEqual({ allowed: true })
  })

  it('allows when the floor is NULL', () => {
    expect(evaluateWriteAccess(row(), '0.0.1')).toEqual({ allowed: true })
  })

  it('allows when the floor is blank', () => {
    expect(evaluateWriteAccess(row({ min_write_version: '   ' }), '0.0.1')).toEqual({
      allowed: true
    })
  })

  it('allows at exactly the floor', () => {
    expect(evaluateWriteAccess(row({ min_write_version: '1.2.0' }), '1.2.0')).toEqual({
      allowed: true
    })
  })

  it('allows above the floor', () => {
    expect(evaluateWriteAccess(row({ min_write_version: '1.2.0' }), '1.2.1')).toEqual({
      allowed: true
    })
  })

  it('rejects below the floor and reports the floor', () => {
    expect(evaluateWriteAccess(row({ min_write_version: '1.2.0' }), '1.1.9')).toEqual({
      allowed: false,
      reason: 'below_floor',
      minVersion: '1.2.0'
    })
  })

  it('allows when the stored floor is unparseable rather than guessing an order', () => {
    expect(evaluateWriteAccess(row({ min_write_version: 'latest' }), '1.0.0')).toEqual({
      allowed: true
    })
  })

  it('rejects on the kill switch regardless of version', () => {
    expect(evaluateWriteAccess(row({ writes_enabled: 0 }), '99.0.0')).toEqual({
      allowed: false,
      reason: 'kill_switch'
    })
  })

  // Chasing an update that cannot help is worse UX than being told writes are
  // off, so the kill switch must win over the floor when both would reject.
  it('reports the kill switch, not the floor, when both apply', () => {
    expect(
      evaluateWriteAccess(row({ writes_enabled: 0, min_write_version: '9.0.0' }), '1.0.0')
    ).toEqual({ allowed: false, reason: 'kill_switch' })
  })
})

describe('toPolicySnapshot', () => {
  it('reports permissive defaults when no row exists', () => {
    expect(toPolicySnapshot('ios', null)).toEqual({ platform: 'ios', writesEnabled: true })
  })

  it('omits the floor when it is NULL', () => {
    expect(toPolicySnapshot('ios', row())).toEqual({ platform: 'ios', writesEnabled: true })
  })

  it('reports the floor and the switch when set', () => {
    expect(toPolicySnapshot('ios', row({ writes_enabled: 0, min_write_version: '2.0.0' }))).toEqual(
      { platform: 'ios', writesEnabled: false, minWriteVersion: '2.0.0' }
    )
  })
})
