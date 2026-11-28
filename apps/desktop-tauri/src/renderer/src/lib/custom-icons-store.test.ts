import { afterEach, describe, expect, it, vi } from 'vitest'

// Every live listener of pulled pages.
const pulled = vi.hoisted(() => new Set<(event: { payload: unknown }) => void>())
const list = vi.hoisted(() => vi.fn())

vi.mock('../../../generated/bindings', () => ({
  events: {
    customIconsUpdatedEvent: { listen: async () => () => undefined },
    syncItemSyncedEvent: {
      listen: async (handler: (event: { payload: unknown }) => void) => {
        pulled.add(handler)
        return () => pulled.delete(handler)
      }
    }
  }
}))
vi.mock('@/services/custom-icons-service', () => ({ customIconsService: { list } }))

import { readCustomIcon } from './custom-icons-store'

afterEach(() => vi.useRealTimers())

describe('custom icons store', () => {
  it('reads the library again when a pulled page holds a custom icon', async () => {
    vi.useFakeTimers()
    list.mockResolvedValue([])
    await readCustomIcon('icon-1')
    await vi.advanceTimersByTimeAsync(0)
    list.mockResolvedValue([
      { id: 'icon-1', name: 'Peer', path: '/vault/.memry/icons/icon-1.png', createdAt: 'now' }
    ])

    const items = [{ itemId: 'icon-1', type: 'custom_icon', itemOperation: 'create' }]
    for (const handler of pulled) handler({ payload: { operation: 'pull', items } })
    await vi.advanceTimersByTimeAsync(150)

    expect(list).toHaveBeenCalledTimes(2)
    expect((await readCustomIcon('icon-1'))?.name).toBe('Peer')
  })
})
