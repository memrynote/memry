import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { SearchChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

interface ReasonRow {
  id: string
  itemId: string
  itemType: string
  itemTitle: string
  searchQuery: string
  visitedAt: string
}

let rows: ReasonRow[] = []

function createChainableMockDb() {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),

    all: vi.fn(() => {
      const sorted = [...rows].sort(
        (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime()
      )
      return sorted.slice(0, 20)
    }),

    get: vi.fn(() => {
      return { count: rows.length }
    }),

    run: vi.fn()
  }

  chain.select.mockImplementation((...args: unknown[]) => {
    const ctx = { _selectArgs: args, _from: '', _where: null as unknown, _orderBy: '' }

    const selectChain = {
      from: vi.fn((_table: unknown) => {
        ctx._from = 'searchReasons'
        return selectChain
      }),
      where: vi.fn((condition: unknown) => {
        ctx._where = condition
        return selectChain
      }),
      orderBy: vi.fn(() => selectChain),
      limit: vi.fn(() => selectChain),
      all: vi.fn(() => {
        const sorted = [...rows].sort(
          (a, b) => new Date(b.visitedAt).getTime() - new Date(a.visitedAt).getTime()
        )
        return sorted.slice(0, 20)
      }),
      get: vi.fn(() => {
        if (args.length > 0 && args[0] && typeof args[0] === 'object' && 'count' in args[0]) {
          return { count: rows.length }
        }
        if (ctx._where) {
          return rows[rows.length - 1] || null
        }
        return rows.length > 0
          ? rows.reduce((oldest, r) =>
              new Date(r.visitedAt).getTime() < new Date(oldest.visitedAt).getTime() ? r : oldest
            )
          : null
      })
    }
    return selectChain
  })

  chain.insert.mockImplementation(() => {
    const insertChain = {
      values: vi.fn((vals: ReasonRow) => {
        const insertData = { ...vals }
        return {
          onConflictDoUpdate: vi.fn((opts: { set: Partial<ReasonRow> }) => ({
            run: vi.fn(() => {
              const existingIdx = rows.findIndex(
                (r) => r.itemType === insertData.itemType && r.itemId === insertData.itemId
              )
              if (existingIdx >= 0) {
                rows[existingIdx] = {
                  ...rows[existingIdx],
                  ...opts.set,
                  itemTitle: opts.set.itemTitle || rows[existingIdx].itemTitle,
                  searchQuery: opts.set.searchQuery || rows[existingIdx].searchQuery,
                  visitedAt: opts.set.visitedAt || rows[existingIdx].visitedAt
                }
              } else {
                rows.push(insertData)
              }
            })
          })),
          run: vi.fn(() => {
            rows.push(insertData)
          })
        }
      })
    }
    return insertChain
  })

  chain.delete.mockImplementation(() => {
    const deleteChain = {
      where: vi.fn((condition: unknown) => ({
        run: vi.fn(() => {
          if (condition && rows.length > 0) {
            const oldest = rows.reduce((o, r) =>
              new Date(r.visitedAt).getTime() < new Date(o.visitedAt).getTime() ? r : o
            )
            rows = rows.filter((r) => r.id !== oldest.id)
          }
        })
      })),
      run: vi.fn(() => {
        rows = []
      })
    }
    return deleteChain
  })

  return chain
}

const mockDb = createChainableMockDb()

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => mockDb),
  getIndexDatabase: vi.fn()
}))

let idCounter = 0
vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => `reason-${++idCounter}`)
}))

vi.mock('@main/database/queries/search', () => ({
  searchAll: vi.fn(),
  quickSearch: vi.fn(),
  getSearchStats: vi.fn()
}))

vi.mock('@main/database/fts-rebuild', () => ({
  rebuildAllIndexes: vi.fn()
}))

import { registerSearchHandlers, unregisterSearchHandlers } from './search-handlers'

describe('search-handlers: reasons', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    rows = []
    idCounter = 0
    registerSearchHandlers()
  })

  afterEach(() => {
    unregisterSearchHandlers()
  })

  describe('GET_REASONS', () => {
    it('returns empty array when no reasons exist', async () => {
      // #when
      const result = await invokeHandler(SearchChannels.invoke.GET_REASONS)

      // #then
      expect(result).toEqual([])
    })

    it('returns reasons ordered by visited_at DESC', async () => {
      // #given
      rows = [
        {
          id: 'r1',
          itemId: 'note-1',
          itemType: 'note',
          itemTitle: 'First Note',
          searchQuery: 'first',
          visitedAt: '2026-03-12T09:00:00.000Z'
        },
        {
          id: 'r2',
          itemId: 'task-1',
          itemType: 'task',
          itemTitle: 'A Task',
          searchQuery: 'second',
          visitedAt: '2026-03-12T10:00:00.000Z'
        }
      ]

      // #when
      const result = await invokeHandler<Array<{ itemId: string }>>(
        SearchChannels.invoke.GET_REASONS
      )

      // #then — most recent first
      expect(result).toHaveLength(2)
      expect(result[0].itemId).toBe('task-1')
      expect(result[1].itemId).toBe('note-1')
    })
  })

  describe('ADD_REASON', () => {
    it('calls insert with correct values', async () => {
      // #when
      await invokeHandler(SearchChannels.invoke.ADD_REASON, {
        itemId: 'note-42',
        itemType: 'note',
        itemTitle: 'Turkey Trip',
        searchQuery: 'turkey visit'
      })

      // #then — verify the insert was called
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('rejects invalid input — empty itemId', async () => {
      // #when + #then
      await expect(
        invokeHandler(SearchChannels.invoke.ADD_REASON, {
          itemId: '',
          itemType: 'note',
          itemTitle: 'X',
          searchQuery: 'q'
        })
      ).rejects.toThrow(/Validation failed/)
    })

    it('rejects invalid input — empty itemTitle', async () => {
      await expect(
        invokeHandler(SearchChannels.invoke.ADD_REASON, {
          itemId: 'note-1',
          itemType: 'note',
          itemTitle: '',
          searchQuery: 'q'
        })
      ).rejects.toThrow(/Validation failed/)
    })

    it('rejects invalid input — empty searchQuery', async () => {
      await expect(
        invokeHandler(SearchChannels.invoke.ADD_REASON, {
          itemId: 'note-1',
          itemType: 'note',
          itemTitle: 'Title',
          searchQuery: ''
        })
      ).rejects.toThrow(/Validation failed/)
    })

    it('rejects invalid content type', async () => {
      await expect(
        invokeHandler(SearchChannels.invoke.ADD_REASON, {
          itemId: 'x-1',
          itemType: 'invalid',
          itemTitle: 'Title',
          searchQuery: 'q'
        })
      ).rejects.toThrow(/Validation failed/)
    })
  })

  describe('CLEAR_REASONS', () => {
    it('calls delete on searchReasons', async () => {
      // #when
      const result = await invokeHandler<{ cleared: true }>(SearchChannels.invoke.CLEAR_REASONS)

      // #then
      expect(result).toEqual({ cleared: true })
      expect(mockDb.delete).toHaveBeenCalled()
    })
  })

  describe('unregisterSearchHandlers', () => {
    it('removes all reason-related channels', () => {
      // #when
      unregisterSearchHandlers()

      // #then
      expect(removeHandlerCalls).toContain(SearchChannels.invoke.GET_REASONS)
      expect(removeHandlerCalls).toContain(SearchChannels.invoke.ADD_REASON)
      expect(removeHandlerCalls).toContain(SearchChannels.invoke.CLEAR_REASONS)
    })
  })
})
