import { describe, expect, it, vi } from 'vitest'

import { claimIdentifySession, IDENTIFY_SESSION_TTL_SECONDS } from './telemetry-identify'

const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT_HASH = 'a'.repeat(64)

const createDb = (run: () => Promise<unknown>) => {
  const bind = vi.fn((..._args: unknown[]) => ({ run }))
  const prepare = vi.fn(() => ({ bind }))
  return { db: { prepare } as unknown as D1Database, prepare, bind }
}

describe('claimIdentifySession', () => {
  it('claims the session when the insert wrote a row', async () => {
    // #given an INSERT that inserted
    const { db } = createDb(async () => ({ meta: { changes: 1 } }))

    // #when claiming
    const claimed = await claimIdentifySession(db, SESSION_ID, ACCOUNT_HASH)

    // #then the caller may emit $identify
    expect(claimed).toBe(true)
  })

  it('does not claim again when the row already exists', async () => {
    // #given ON CONFLICT DO NOTHING hit an existing row
    const { db } = createDb(async () => ({ meta: { changes: 0 } }))

    // #when claiming
    const claimed = await claimIdentifySession(db, SESSION_ID, ACCOUNT_HASH)

    // #then the permanent merge is suppressed for this session
    expect(claimed).toBe(false)
  })

  it('keys the row by session AND account hash', async () => {
    // #given a claim
    const { db, bind } = createDb(async () => ({ meta: { changes: 1 } }))

    // #when claiming
    await claimIdentifySession(db, SESSION_ID, ACCOUNT_HASH)

    // #then two accounts sharing a session id get separate rows
    expect(bind.mock.calls[0][0]).toBe(`${SESSION_ID}:${ACCOUNT_HASH}`)
  })

  it('fails open so a D1 error costs duplicate merges, not a missing one', async () => {
    // #given D1 throwing
    const { db } = createDb(async () => {
      throw new Error('D1_ERROR')
    })

    // #when claiming
    const claimed = await claimIdentifySession(db, SESSION_ID, ACCOUNT_HASH)

    // #then $identify still fires (idempotent in PostHog) rather than the
    // install never linking to its account
    expect(claimed).toBe(true)
  })

  it('exposes a TTL long enough to cover a normal app session', () => {
    expect(IDENTIFY_SESSION_TTL_SECONDS).toBe(86400)
  })
})
