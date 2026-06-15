import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

import { runImport, previewImport, cancelImport } from './runner'
import { registerImporter, __resetRegistry } from './registry'
import type { Importer } from './types'

describe('runner', () => {
  beforeEach(() => __resetRegistry())

  it('runs the named importer and returns its summary', async () => {
    const imp: Importer = {
      id: 'x',
      name: 'X',
      descriptionKey: 'k.x',
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
      descriptionKey: 'k.y',
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

  it('previews via the importer preview hook', async () => {
    const imp: Importer = {
      id: 'p',
      name: 'P',
      descriptionKey: 'k.p',
      fileSpec: { label: 'P', extensions: ['csv'], allowMultiple: true },
      preview: async () => ({ groups: [{ label: 'g', counts: [{ labelKey: 'k', value: 2 }] }] }),
      run: async (_input, ctx) => ctx.toSummary()
    }
    registerImporter(imp)
    const out = await previewImport({ importId: 'p1', importerId: 'p', sourcePaths: ['/x.csv'] })
    expect(out.groups[0].counts[0].value).toBe(2)
  })

  it('throws previewing an importer with no preview hook', async () => {
    const imp: Importer = {
      id: 'np',
      name: 'NP',
      descriptionKey: 'k.np',
      fileSpec: { label: 'NP', extensions: ['csv'], allowMultiple: true },
      run: async (_input, ctx) => ctx.toSummary()
    }
    registerImporter(imp)
    await expect(
      previewImport({ importId: 'p2', importerId: 'np', sourcePaths: [] })
    ).rejects.toThrow(/no preview/)
  })
})
