import { describe, expect, it } from 'vitest'

import { toEpochMs } from '../note-ops'

/**
 * A note timestamp has two live shapes on the same device, and reading one
 * without coercing has now cost two bugs: the `created-*` sort modes silently
 * ordering every desktop-synced note by `updated_at`, and the read screen's
 * `Edited` line vanishing because `'2025-02-13T…' > 0` is false. This suite is
 * why the coercion lives in one place next to `NotePayload`.
 */
describe('toEpochMs', () => {
  const fallback = 1_700_000_000_000

  it('takes an epoch number as written', () => {
    expect(toEpochMs(1_787_932_999_482, fallback)).toBe(1_787_932_999_482)
  })

  it('parses the ISO string desktop writes', () => {
    expect(toEpochMs('2025-02-13T16:45:00.000Z', fallback)).toBe(
      Date.parse('2025-02-13T16:45:00.000Z')
    )
  })

  it('falls back rather than producing NaN, for every shape that is neither', () => {
    for (const value of [undefined, null, '', 'not a date', {}, [], true, NaN, Infinity]) {
      expect(toEpochMs(value, fallback)).toBe(fallback)
    }
  })

  it('returns a number a comparison can use, whichever shape came in', () => {
    // The read screen's guard was `editedAt > 0`. An uncoerced ISO string makes
    // that false and the timestamp disappears.
    for (const value of [1_787_932_999_482, '2025-02-13T16:45:00.000Z', 'nonsense']) {
      expect(toEpochMs(value, fallback)).toBeGreaterThan(0)
    }
  })
})
