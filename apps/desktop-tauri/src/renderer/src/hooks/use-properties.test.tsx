import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { useProperties } from './use-properties'

const service = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  merge: vi.fn(),
  rename: vi.fn()
}))

vi.mock('@/services/properties-service', () => ({ propertiesService: service }))

describe('useProperties', () => {
  let api: ReturnType<typeof createMockApi>
  const initialProperties = [
    { name: 'status', value: 'draft', type: 'text' },
    { name: 'priority', value: 2, type: 'number' }
  ]

  beforeEach(() => {
    api = createMockApi()
    service.get.mockResolvedValue(initialProperties)
    service.set.mockResolvedValue({ success: true })
    service.rename.mockResolvedValue({ success: true })
    api.onItemSynced = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads properties, exposes a record, and refreshes on pulled item sync events', async () => {
    const syncCallbacks: Array<
      (event: { operation: string; itemId: string; type: string }) => void
    > = []
    api.onItemSynced = vi.fn((callback) => {
      syncCallbacks.push(callback)
      return () => {}
    })

    const { result } = renderHook(() => useProperties('note-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(service.get).toHaveBeenCalledWith('note-1')
    expect(result.current.propertiesRecord).toEqual({ status: 'draft', priority: 2 })

    service.get.mockResolvedValue([{ name: 'status', value: 'review', type: 'text' }])

    await act(async () => {
      syncCallbacks[0]({ operation: 'pull', itemId: 'note-1', type: 'note' })
    })

    await waitFor(() => {
      expect(result.current.propertiesRecord).toEqual({ status: 'review' })
    })
  })

  it('refetches when another surface writes properties this hook does not hold', async () => {
    type UpdatedEvent = { id: string; changes: { properties?: Record<string, unknown> } }
    const updateCallbacks: Array<(event: UpdatedEvent) => void> = []
    api.onNoteUpdated = vi.fn((callback: (event: UpdatedEvent) => void) => {
      updateCallbacks.push(callback)
      return () => {}
    })

    const { result } = renderHook(() => useProperties('note-1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(service.get).toHaveBeenCalledTimes(1)

    // Echo of the hook's own state, another note, and a content-only update: no refetch.
    await act(async () => {
      updateCallbacks[0]({
        id: 'note-1',
        changes: { properties: { status: 'draft', priority: 2 } }
      })
      updateCallbacks[0]({ id: 'note-2', changes: { properties: { other: true } } })
      updateCallbacks[0]({ id: 'note-1', changes: {} })
    })
    expect(service.get).toHaveBeenCalledTimes(1)

    const related = ['memry://note/note-b']
    service.get.mockResolvedValue([
      ...initialProperties,
      { name: 'related', value: related, type: 'relation' }
    ])
    await act(async () => {
      updateCallbacks[0]({
        id: 'note-1',
        changes: { properties: { status: 'draft', priority: 2, related } }
      })
    })

    await waitFor(() => {
      expect(result.current.propertiesRecord).toEqual({ status: 'draft', priority: 2, related })
    })
  })

  it('updates, adds, removes, renames, reorders, and skips no-op paths', async () => {
    const { result } = renderHook(() => useProperties('note-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateProperty('status', 'review')
    })
    // Each write carries the record it was made from.
    expect(service.set).toHaveBeenLastCalledWith(
      'note-1',
      { status: 'review', priority: 2 },
      { status: 'draft', priority: 2 }
    )

    await act(async () => {
      await result.current.addProperty('status', true)
    })
    expect(service.set).toHaveBeenLastCalledWith(
      'note-1',
      { status: 'review', priority: 2, 'status 2': true },
      { status: 'review', priority: 2 }
    )

    await act(async () => {
      await result.current.removeProperty('priority')
    })
    expect(service.set).toHaveBeenLastCalledWith(
      'note-1',
      { status: 'review', 'status 2': true },
      { status: 'review', priority: 2, 'status 2': true }
    )

    await act(async () => {
      await result.current.renameProperty('status 2', 'done')
    })
    expect(service.rename).toHaveBeenCalledWith('note-1', 'status 2', 'done')

    await act(async () => {
      await result.current.renameProperty('done', 'done')
      await result.current.reorderProperties(['done', 'status'])
    })
    expect(service.set).toHaveBeenLastCalledWith(
      'note-1',
      { done: true, status: 'review' },
      { status: 'review', done: true }
    )
    expect(service.rename).toHaveBeenCalledTimes(1)
  })

  it('rolls back from persistence errors', async () => {
    service.set.mockResolvedValueOnce({ success: false, error: 'write failed' })
    const { result } = renderHook(() => useProperties('note-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(
      act(async () => {
        await result.current.updateProperty('status', 'broken')
      })
    ).rejects.toThrow('write failed')

    expect(service.get).toHaveBeenCalledTimes(2)
  })
})
