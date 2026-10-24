/**
 * The canvas half of the editor's link grammar (#1983): one cached list, an
 * untitled canvas that no link can name, and a case-insensitive title match.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/services/canvas-service', () => ({
  canvasService: { list: (...args: unknown[]) => mocks.list(...args) }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.error })
}))

import { clearCanvasLookupCache, listTitledCanvases, resolveCanvasByTitle } from './canvas-lookup'

describe('canvas-lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCanvasLookupCache()
    mocks.list.mockResolvedValue({
      canvases: [
        { id: 'canvas-1', title: 'Sprint Board' },
        { id: 'canvas-2', title: '  ' },
        { id: 'canvas-3', title: null }
      ]
    })
  })

  it('lists only canvases a link could name', async () => {
    expect(await listTitledCanvases()).toEqual([{ id: 'canvas-1', title: 'Sprint Board' }])
  })

  it('asks once and serves the rest of the window from the cache', async () => {
    await listTitledCanvases()
    await resolveCanvasByTitle('Sprint Board')

    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('matches a title case- and whitespace-insensitively', async () => {
    expect(await resolveCanvasByTitle('  sprint BOARD ')).toEqual({
      id: 'canvas-1',
      title: 'Sprint Board'
    })
    expect(await resolveCanvasByTitle('No Such Board')).toBeNull()
    expect(await resolveCanvasByTitle('   ')).toBeNull()
  })

  it('answers "no canvas" rather than throwing when the list call fails', async () => {
    clearCanvasLookupCache()
    mocks.list.mockRejectedValue(new Error('ipc down'))

    expect(await resolveCanvasByTitle('Sprint Board')).toBeNull()
    expect(mocks.error).toHaveBeenCalled()
  })
})
