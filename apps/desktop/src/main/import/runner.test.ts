import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { runImport, cancelImport } from './runner'
import { registerImporter, __resetRegistry } from './registry'
import type { Importer } from './types'

describe('runner', () => {
  beforeEach(() => __resetRegistry())

  it('runs the named importer and returns its summary', async () => {
    const imp: Importer = {
      id: 'x',
      name: 'X',
      fileSpec: { label: 'X', extensions: ['zip'], allowMultiple: false },
      run: async () => ({ imported: 5, attachments: 0, skipped: 0, failed: [] })
    }
    registerImporter(imp)
    const s = await runImport({ importId: 'r1', importerId: 'x', sourcePaths: ['a.zip'] })
    expect(s.imported).toBe(5)
  })

  it('throws for unknown importer id', async () => {
    await expect(
      runImport({ importId: 'r2', importerId: 'nope', sourcePaths: [] })
    ).rejects.toThrow(/unknown importer/i)
  })

  it('cancel aborts the run signal', async () => {
    let cancelledSeen = false
    const imp: Importer = {
      id: 'y',
      name: 'Y',
      fileSpec: { label: 'Y', extensions: ['zip'], allowMultiple: false },
      run: async (_input, ctx) => {
        cancelImport('r3')
        cancelledSeen = ctx.isCancelled()
        return { imported: 0, attachments: 0, skipped: 0, failed: [] }
      }
    }
    registerImporter(imp)
    await runImport({ importId: 'r3', importerId: 'y', sourcePaths: [] })
    expect(cancelledSeen).toBe(true)
  })
})
