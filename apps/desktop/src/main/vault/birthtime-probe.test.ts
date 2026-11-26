/**
 * The startup probe tells a real birthtime from libuv's ctime stand-in (Linux
 * without statx) by moving a temp file's ctime.
 *
 * @module vault/birthtime-probe.test
 */

import type { Stats } from 'fs'
import type * as FsPromises from 'fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadProbe() {
  vi.resetModules()
  return await import('./birthtime-probe')
}

describe('probeBirthtime', () => {
  afterEach(() => {
    vi.doUnmock('fs/promises')
  })

  it('finds real birthtimes where stat reports them', async () => {
    const { birthtimeIsReal, probeBirthtime } = await loadProbe()
    expect(birthtimeIsReal()).toBeNull()
    expect(await probeBirthtime()).toBe(true)
    expect(birthtimeIsReal()).toBe(true)
  })

  it('finds the ctime stand-in where stat reports the ctime as birthtime', async () => {
    vi.doMock('fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof FsPromises>()
      const stat = async (file: string): Promise<Stats> => {
        const stats = await actual.stat(file)
        stats.birthtimeMs = stats.ctimeMs
        stats.birthtime = new Date(stats.ctimeMs)
        return stats
      }
      return { ...actual, stat, default: { ...actual, stat } }
    })
    const { birthtimeIsReal, probeBirthtime } = await loadProbe()
    expect(await probeBirthtime()).toBe(false)
    expect(birthtimeIsReal()).toBe(false)
  })
})
