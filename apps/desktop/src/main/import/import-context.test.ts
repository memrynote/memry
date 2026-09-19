import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }] }
}))

import { createImportContext } from './import-context'
import { ImportChannels, MAX_SKIPPED_REASON_GROUPS } from '@memry/contracts/import-channels'

describe('import context', () => {
  beforeEach(() => send.mockClear())

  it('tallies notes/attachments/skipped/failed into summary', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    ctx.reportImported()
    ctx.reportImported()
    ctx.reportAttachment()
    ctx.reportSkipped('a.html', 'empty')
    ctx.reportFailed('b.html', new Error('boom'))
    const s = ctx.toSummary()
    expect(s).toEqual({
      imported: 2,
      attachments: 1,
      skipped: 1,
      failed: [{ item: 'b.html', error: 'boom' }],
      skippedReasons: [{ reason: 'empty', count: 1 }]
    })
  })

  it('groups skipped items by reason, keyed by code when there is one', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    const locked = { code: 'appleNotes.lockedNote', message: 'Locked notes were not imported' }
    ctx.reportSkipped('Passwords', locked)
    ctx.reportSkipped('Bank', { ...locked, message: 'different text, same code' })
    ctx.reportSkipped('a.png', 'attachment not found')

    expect(ctx.toSummary().skippedReasons).toEqual([
      { reason: locked, count: 2 },
      { reason: 'attachment not found', count: 1 }
    ])
  })

  it('counts a reasonless skip without inventing a group', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    ctx.reportSkipped('a.html')
    const s = ctx.toSummary()
    expect(s.skipped).toBe(1)
    expect(s.skippedReasons).toBeUndefined()
  })

  it('caps distinct reasons while still counting every skip', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    // Reasons can embed a varying error string; the payload must stay bounded.
    for (let i = 0; i < MAX_SKIPPED_REASON_GROUPS + 5; i++)
      ctx.reportSkipped(`f${i}`, `reason ${i}`)
    const s = ctx.toSummary()
    expect(s.skipped).toBe(MAX_SKIPPED_REASON_GROUPS + 5)
    expect(s.skippedReasons).toHaveLength(MAX_SKIPPED_REASON_GROUPS)
  })

  it('keeps a coded reason that arrives after the free-text cap is full', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    // An Apple Notes vault whose early notes carry unsupported attachments
    // emits one distinct free-text reason per extension before the first
    // locked note is reached; the locked-note line still has to appear.
    for (let i = 0; i < MAX_SKIPPED_REASON_GROUPS + 5; i++)
      ctx.reportSkipped(`f${i}.bin`, `File type ".x${i}" is not allowed`)
    const locked = { code: 'appleNotes.lockedNote', message: 'Locked notes were not imported' }
    ctx.reportSkipped('Passwords', locked)

    expect(ctx.toSummary().skippedReasons).toContainEqual({ reason: locked, count: 1 })
  })

  it('emits a progress event keyed by importId', () => {
    const ctx = createImportContext('id1', new AbortController().signal)
    ctx.reportProgress(3, 10)
    expect(send).toHaveBeenCalledWith(
      ImportChannels.events.PROGRESS,
      expect.objectContaining({ importId: 'id1', completed: 3, total: 10 })
    )
  })

  it('reflects an aborted signal in isCancelled()', () => {
    const ac = new AbortController()
    const ctx = createImportContext('id1', ac.signal)
    expect(ctx.isCancelled()).toBe(false)
    ac.abort()
    expect(ctx.isCancelled()).toBe(true)
  })
})
