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
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
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

  const corruptError = (table: string): Error =>
    Object.assign(new Error(`fts5: corruption found in ${table}`), {
      code: 'SQLITE_CORRUPT_VTAB'
    })

  it('detectCorruption reports every corrupt FTS table', () => {
    const failingIndexDb = {
      run: vi.fn(() => {
        throw corruptError('fts_notes')
      })
    }
    const failingDataDb = {
      run: vi
        .fn()
        .mockImplementationOnce(() => {
          throw corruptError('fts_tasks')
        })
        .mockImplementationOnce(() => {
          throw corruptError('fts_inbox')
        })
    }

    expect(detectCorruption(failingIndexDb as never, failingDataDb as never)).toEqual([
      'fts_notes',
      'fts_tasks',
      'fts_inbox'
    ])
  })

  it('detectCorruption ignores a failure that is not corruption', () => {
    // A locked database is transient. Reporting it would cost the user a full
    // rebuild of an index that is perfectly fine.
    const busy = () => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    }

    expect(detectCorruption({ run: vi.fn(busy) } as never, { run: vi.fn(busy) } as never)).toEqual(
      []
    )
  })
})
