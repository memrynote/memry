import { describe, expect, it, vi } from 'vitest'

import { claimExceptionBudget, EXCEPTION_BUDGET_PER_HOUR } from './exception-budget'

// Minimal D1 stand-in: `batch` resolves with a canned SELECT result carrying
// the post-upsert count, mirroring the [upsert, select] pair the claim issues.
const dbWithCount = (count: number | undefined): D1Database => {
  const statement = { bind: vi.fn().mockReturnThis() }
  return {
    prepare: vi.fn(() => statement),
    batch: vi
      .fn()
      .mockResolvedValue([{ results: [] }, { results: count === undefined ? [] : [{ count }] }])
  } as unknown as D1Database
}

describe('claimExceptionBudget', () => {
  it('grants the full request while the window has room', async () => {
    expect(await claimExceptionBudget(dbWithCount(5), 'hash', 5)).toBe(5)
  })

  it('grants exactly up to the cap when the request straddles it', async () => {
    // 55 already used before this batch of 10 → only 5 slots remain.
    expect(await claimExceptionBudget(dbWithCount(65), 'hash', 10)).toBe(5)
  })

  it('grants nothing once the window is exhausted', async () => {
    expect(
      await claimExceptionBudget(dbWithCount(EXCEPTION_BUDGET_PER_HOUR + 20), 'hash', 10)
    ).toBe(0)
  })

  it('short-circuits a zero-size request without touching the database', async () => {
    const db = dbWithCount(0)
    expect(await claimExceptionBudget(db, 'hash', 0)).toBe(0)
    expect((db as unknown as { batch: ReturnType<typeof vi.fn> }).batch).not.toHaveBeenCalled()
  })

  // A flaky database must cost extra PostHog events, never a swallowed crash.
  it('fails open when D1 errors', async () => {
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis() })),
      batch: vi.fn().mockRejectedValue(new Error('D1 down'))
    } as unknown as D1Database
    expect(await claimExceptionBudget(db, 'hash', 7)).toBe(7)
  })

  it('fails open when the select comes back empty', async () => {
    expect(await claimExceptionBudget(dbWithCount(undefined), 'hash', 4)).toBe(4)
  })
})
