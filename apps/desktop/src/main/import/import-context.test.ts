import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ]
  }
}))

import { createImportContext } from './import-context'
import { ImportChannels } from '@memry/contracts/import-channels'

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
      failed: [{ item: 'b.html', error: 'boom' }]
    })
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
