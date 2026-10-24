import { afterEach, describe, expect, it } from 'vitest'
import { runInTz } from './test-support/run-in-tz'

/**
 * Documents the trap #1955 found: the renderer vitest project runs on vitest's `threads` pool,
 * where `process.env` is a per-worker copy. Assigning `process.env.TZ` at runtime updates that
 * copy but never reaches the C++ `tzset` the JS Date/Intl machinery reads, so the process stays
 * pinned to the host's zone no matter what a test sets. Any test that parameterised over
 * timezones this way ran every case in the host's zone and passed tautologically — see
 * `local-day-range.test.ts`, `journal-day-panel-day-range.test.tsx`, and
 * `journal-template-resolution.test.ts` for the real fix, which spawns a child `node` process via
 * `runInTz` instead.
 *
 * This test proves the trap directly, rather than relying on that fix's own tests to imply it: it
 * asserts that flipping `process.env.TZ` in-process does *not* change the observed UTC offset,
 * and it cross-checks against a real child process, where the same flip *does* change it.
 */
describe('process.env.TZ in the renderer project', () => {
  const originalTZ = process.env.TZ

  afterEach(() => {
    process.env.TZ = originalTZ
  })

  function offsetMinutes(): number {
    // getTimezoneOffset() is UTC-minus-local, in minutes.
    return new Date(2026, 5, 24, 12, 0, 0, 0).getTimezoneOffset()
  }

  it('does not change the observed offset in-process, across four different zones', () => {
    const before = offsetMinutes()
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      process.env.TZ = tz
      expect(offsetMinutes()).toBe(before)
    }
  })

  it('does change the offset in a real child process given the same TZ values', () => {
    const source = `
      process.stdout.write(
        JSON.stringify(new Date(2026, 5, 24, 12, 0, 0, 0).getTimezoneOffset())
      )
    `
    const offsets = ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati'].map((tz) =>
      runInTz<number>(tz, source)
    )
    // UTC is 0, Los Angeles is positive (behind UTC), Kolkata and Kiritimati are negative (ahead
    // of UTC) -- so at least two distinct offsets prove the child process actually moved.
    expect(new Set(offsets).size).toBeGreaterThan(1)
  })
})
