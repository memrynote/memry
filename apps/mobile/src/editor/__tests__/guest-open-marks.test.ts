import { describe, expect, it } from 'vitest'
import { beginOpenMarks, guestMarks, markGuest } from '../../../editor-web/src/open-marks'
import { isForMountedDoc } from '../../../editor-web/src/routing'

/**
 * The two things the guest has to get right now that ONE WebView serves every
 * note (#2030): it must not report a previous open's numbers as this open's,
 * and it must not act on a command addressed to a note it is no longer
 * showing. Both fail silently — a fabricated latency, an edit in the wrong
 * note — which is what makes them worth pinning.
 *
 * `open-marks` is a module singleton by design (it takes the earliest possible
 * timestamp at module eval), so these cases run against a shared record and
 * step through opens in order rather than each starting from nothing.
 */

describe('guest open marks', () => {
  it('keeps the boot marks for the first open and drops them for the next', () => {
    // Open 1. `docStart` and `importsStart` were taken at module eval, which
    // for the first open IS its startup cost.
    beginOpenMarks()
    markGuest('docLoadRecv')
    markGuest('guestPainted')

    const first = guestMarks()
    expect(first.docStart).toBeDefined()
    expect(first.importsStart).toBeDefined()
    const firstPainted = first.guestPainted

    // Open 2 on the same WebView. Reporting the boot marks again would print a
    // startup that happened before the user tapped anything, and reusing the
    // first paint stamp would report an open that finished before it began.
    beginOpenMarks()
    markGuest('docLoadRecv')

    const second = guestMarks()
    expect(second.docStart).toBeUndefined()
    expect(second.importsStart).toBeUndefined()
    expect(second.readySent).toBeUndefined()
    expect(second.guestPainted).toBeUndefined()
    expect(second.guestPainted).not.toBe(firstPainted)
    expect(second.docLoadRecv).toBeDefined()
  })

  it('carries an early probe mark into the open it announces', () => {
    // The host queues `probe: early` immediately AHEAD of `doc-load` so it is
    // timed before the open begins. Wiping it with the rest would erase the
    // one mark the probe exists to take.
    markGuest('probeEarlyRecv')
    const probed = guestMarks().probeEarlyRecv

    beginOpenMarks()

    expect(guestMarks().probeEarlyRecv).toBe(probed)
    expect(guestMarks().docLoadRecv).toBeUndefined()
  })
})

describe('isForMountedDoc', () => {
  it('drops a command addressed to a note that is not mounted', () => {
    expect(isForMountedDoc({ type: 'exec', cmd: 'undo', docId: 'note-a' }, 'note-b')).toBe(false)
    expect(
      isForMountedDoc(
        { type: 'insert-attachment', docId: 'note-a', ref: 'a.png', name: '', mime: '', width: 0 },
        'note-b'
      )
    ).toBe(false)
  })

  it('runs a command addressed to the mounted note', () => {
    expect(isForMountedDoc({ type: 'exec', cmd: 'undo', docId: 'note-a' }, 'note-a')).toBe(true)
    expect(
      isForMountedDoc(
        { type: 'insert-attachment', docId: 'note-a', ref: 'a.png', name: '', mime: '', width: 0 },
        'note-a'
      )
    ).toBe(true)
  })

  it('lets an unaddressed command through, because a bridge flush owns no note', () => {
    expect(isForMountedDoc({ type: 'exec', cmd: 'flush' }, 'note-a')).toBe(true)
    expect(isForMountedDoc({ type: 'exec', cmd: 'flush' }, null)).toBe(true)
  })

  it('still holds y-update to the note it names', () => {
    expect(isForMountedDoc({ type: 'y-update', docId: 'note-a', updatesB64: [] }, 'note-b')).toBe(
      false
    )
    expect(isForMountedDoc({ type: 'y-update', docId: 'note-a', updatesB64: [] }, 'note-a')).toBe(
      true
    )
  })
})
