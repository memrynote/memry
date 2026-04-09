import { describe, expect, it, vi, beforeEach } from 'vitest'

const rebuildProjections = vi.hoisted(() => vi.fn())
const getAllWindows = vi.hoisted(() => vi.fn())

vi.mock('../projections', () => ({
  rebuildProjections
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows
  }
}))

import { detectCorruption, rebuildAllIndexes } from './fts-rebuild'

describe('fts rebuild recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAllWindows.mockReturnValue([
      {
        webContents: {
          send: vi.fn()
        }
      }
    ])
  })

  it('rebuildAllIndexes delegates full-text recovery to the search projector rebuild', async () => {
    rebuildProjections.mockResolvedValue({
      search: {
        notes: 4,
        tasks: 2,
        inbox: 1,
        durationMs: 123
      }
    })

    await expect(rebuildAllIndexes({} as never, {} as never)).resolves.toEqual({
      notes: 4,
      tasks: 2,
      inbox: 1,
      durationMs: 123
    })

    expect(rebuildProjections).toHaveBeenCalledWith(['search'])
  })

  it('detectCorruption reports every corrupt FTS table', () => {
    const failingIndexDb = {
      all: vi.fn(() => {
        throw new Error('fts_notes corrupt')
      })
    }
    const failingDataDb = {
      all: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('fts_tasks corrupt')
        })
        .mockImplementationOnce(() => {
          throw new Error('fts_inbox corrupt')
        })
    }

    expect(detectCorruption(failingIndexDb as never, failingDataDb as never)).toEqual([
      'fts_notes',
      'fts_tasks',
      'fts_inbox'
    ])
  })
})
