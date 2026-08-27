import { describe, expect, it } from 'vitest'
import { shouldSeedFromMarkdown } from '../note-ops'

/**
 * The seed decision, isolated.
 *
 * Seeding a note's editor from `note_bodies` is the one operation in the write
 * path whose failure is UNRECOVERABLE: the record applier fills that table for
 * every pulled note from its create-time content, so seeding a note the server
 * already holds CRDT state for pushes a second copy of the body — and it
 * appears twice on every device, forever.
 *
 * Two boolean collapses caused exactly that, twice. This pins the rule that
 * came out of it.
 */
describe('shouldSeedFromMarkdown', () => {
  it('seeds a note this device just created, even with no probe', () => {
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: true, probe: 'not-run' })).toBe(
      true
    )
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: true, probe: 'failed' })).toBe(
      true
    )
  })

  it('seeds a pulled note only when a probe completed and found nothing', () => {
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: false, probe: 'empty' })).toBe(
      true
    )
  })

  it('does NOT seed when the probe could not run', () => {
    // Offline, locked, or a failed request: the server's state is unknown, and
    // guessing wrong duplicates the body permanently.
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: false, probe: 'failed' })).toBe(
      false
    )
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: false, probe: 'not-run' })).toBe(
      false
    )
  })

  it('does NOT seed when the probe found content', () => {
    expect(shouldSeedFromMarkdown({ docIsEmpty: true, createdHere: false, probe: 'updated' })).toBe(
      false
    )
  })

  it('never seeds a doc that already has content', () => {
    for (const probe of ['empty', 'updated', 'failed', 'not-run'] as const) {
      expect(shouldSeedFromMarkdown({ docIsEmpty: false, createdHere: true, probe })).toBe(false)
    }
  })
})
