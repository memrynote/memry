import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteLinksChangedEvent } from '@memry/contracts/notes-api'
import { graphKeys, useGraphReactivity } from './use-graph-data'

const linksChanged = vi.hoisted(() => new Set<(event: NoteLinksChangedEvent) => void>())
const none = vi.hoisted(() => () => () => {})

vi.mock('@/services/notes-service', () => ({
  onNoteCreated: none,
  onNoteUpdated: none,
  onNoteDeleted: none,
  onNoteLinksChanged: (callback: (event: NoteLinksChangedEvent) => void) => {
    linksChanged.add(callback)
    return () => linksChanged.delete(callback)
  }
}))
vi.mock('@/services/tasks-service', () => ({
  onTaskCreated: none,
  onTaskUpdated: none,
  onTaskDeleted: none
}))
vi.mock('@/services/canvas-service', () => ({
  onCanvasCreated: none,
  onCanvasUpdated: none,
  onCanvasDeleted: none
}))

describe('useGraphReactivity', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refetches the graph once the index announces changed links', () => {
    vi.useFakeTimers()
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { unmount } = renderHook(() => useGraphReactivity(), { wrapper })

    act(() => {
      for (const callback of linksChanged) callback({ sourceIds: ['a'], targetIds: ['b'] })
      vi.advanceTimersByTime(250)
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: graphKeys.all })
    unmount()
    expect(linksChanged.size).toBe(0)
  })
})
