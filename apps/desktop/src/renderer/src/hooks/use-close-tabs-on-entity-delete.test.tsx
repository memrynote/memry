import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDeletedEvent } from '@memry/contracts/canvas-api'
import { useCloseTabsOnEntityDelete } from './use-close-tabs-on-entity-delete'

const mocks = vi.hoisted(() => ({
  deletedListener: null as ((event: CanvasDeletedEvent) => void) | null,
  unsubscribe: vi.fn(),
  closeTabsByEntityId: vi.fn()
}))

vi.mock('@/services/canvas-service', () => ({
  onCanvasDeleted: vi.fn((callback: (event: CanvasDeletedEvent) => void) => {
    mocks.deletedListener = callback
    return mocks.unsubscribe
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ closeTabsByEntityId: mocks.closeTabsByEntityId })
}))

describe('useCloseTabsOnEntityDelete', () => {
  beforeEach(() => {
    mocks.deletedListener = null
    mocks.unsubscribe.mockClear()
    mocks.closeTabsByEntityId.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('closes the tabs of a canvas the moment its delete is announced', () => {
    renderHook(() => useCloseTabsOnEntityDelete())

    act(() => mocks.deletedListener?.({ id: 'canvas-1' }))

    expect(mocks.closeTabsByEntityId).toHaveBeenCalledWith('canvas-1')
  })

  it('closes one set of tabs per canvas a folder delete took with it', () => {
    // `ipc/canvas-folder-handlers` emits one `canvas:deleted` per canvas in the
    // deleted subtree; nothing else tells this hook those canvases are gone.
    renderHook(() => useCloseTabsOnEntityDelete())

    act(() => {
      mocks.deletedListener?.({ id: 'canvas-1' })
      mocks.deletedListener?.({ id: 'canvas-2' })
    })

    expect(mocks.closeTabsByEntityId.mock.calls).toEqual([['canvas-1'], ['canvas-2']])
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useCloseTabsOnEntityDelete())

    unmount()

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
