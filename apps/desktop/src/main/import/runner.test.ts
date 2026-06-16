import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../projections', () => ({
  flushProjectionEvents: vi.fn().mockResolvedValue(undefined)
}))

import { runImport, previewImport, cancelImport } from './runner'
import { registerImporter, __resetRegistry } from './registry'
import { flushProjectionEvents } from '../projections'
import type { Importer } from './types'

describe('runner', () => {
  beforeEach(() => {
    __resetRegistry()
    vi.mocked(flushProjectionEvents).mockClear().mockResolvedValue(undefined)
  })

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

  it('flushes projection events after the importer finishes', async () => {
    // Importers create notes through the async projection pipeline; their
    // note_cache rows are only written when the projection bus drains. The run
    // must flush after the importer so a post-import notes-list refetch sees
    // every imported note instead of empty folders until the next reload.
    const order: string[] = []
    vi.mocked(flushProjectionEvents).mockImplementation(async () => {
      order.push('flush')
    })
    const imp: Importer = {
      id: 'f',
      name: 'F',
      descriptionKey: 'k.f',
      fileSpec: { label: 'F', extensions: ['md'], allowMultiple: true },
      run: async () => {
        order.push('run')
        return { imported: 3, attachments: 0, skipped: 0, failed: [] }
      }
    }
    registerImporter(imp)
    await runImport({ importId: 'rf', importerId: 'f', sourcePaths: ['a.md'] })
    expect(flushProjectionEvents).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['run', 'flush'])
  })

  it('flushes projection events even when the importer throws', async () => {
    const imp: Importer = {
      id: 'fe',
      name: 'FE',
      descriptionKey: 'k.fe',
      fileSpec: { label: 'FE', extensions: ['md'], allowMultiple: true },
      run: async () => {
        throw new Error('boom')
      }
    }
    registerImporter(imp)
    await expect(runImport({ importId: 'rfe', importerId: 'fe', sourcePaths: [] })).rejects.toThrow(
      'boom'
    )
    expect(flushProjectionEvents).toHaveBeenCalledTimes(1)
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
