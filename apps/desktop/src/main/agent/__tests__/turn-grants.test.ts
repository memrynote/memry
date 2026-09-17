import { beforeEach, describe, expect, it } from 'vitest'

import {
  mintTurnWriteGrant,
  resolveTurnWriteGrant,
  revokeAllTurnWriteGrants,
  revokeTurnWriteGrantsFor
} from '../turn-grants'

describe('turn write grants', () => {
  beforeEach(() => {
    revokeAllTurnWriteGrants()
  })

  it('mints an unguessable capability that resolves to its conversation', () => {
    const grant = mintTurnWriteGrant('conversation-1')
    expect(grant).toMatch(/^[0-9a-f]{64}$/)
    expect(resolveTurnWriteGrant(grant)).toBe('conversation-1')
  })

  it('resolves nothing for a conversation id, which is what a client could guess', () => {
    mintTurnWriteGrant('conversation-1')
    expect(resolveTurnWriteGrant('conversation-1')).toBeNull()
    expect(resolveTurnWriteGrant(null)).toBeNull()
    expect(resolveTurnWriteGrant('')).toBeNull()
  })

  it('mints a fresh capability per turn and drops the previous one', () => {
    const first = mintTurnWriteGrant('conversation-1')
    const second = mintTurnWriteGrant('conversation-1')
    expect(second).not.toBe(first)
    expect(resolveTurnWriteGrant(first)).toBeNull()
    expect(resolveTurnWriteGrant(second)).toBe('conversation-1')
  })

  it('revokes only the conversation whose turn ended', () => {
    const one = mintTurnWriteGrant('conversation-1')
    const two = mintTurnWriteGrant('conversation-2')

    revokeTurnWriteGrantsFor('conversation-1')

    expect(resolveTurnWriteGrant(one)).toBeNull()
    expect(resolveTurnWriteGrant(two)).toBe('conversation-2')
  })

  it('revokes everything when the vault closes', () => {
    const grant = mintTurnWriteGrant('conversation-1')
    revokeAllTurnWriteGrants()
    expect(resolveTurnWriteGrant(grant)).toBeNull()
  })
})
