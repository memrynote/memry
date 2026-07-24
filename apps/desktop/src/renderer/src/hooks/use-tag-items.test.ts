import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useTagItems } from './use-tag-items'

const listItems = vi.fn()

// `onTagNotesChanged` isn't part of the brief's illustrative mock (which only
// covers what the three example assertions touch), but the hook itself
// subscribes to it to refetch on tag/note changes — omitting it here would
// throw ("onTagNotesChanged is not a function") the moment the hook mounts.
vi.mock('@/services/tags-service', () => ({
  tagsService: { listItems: (...a: unknown[]) => listItems(...a) },
  onTagRenamed: () => () => {},
  onTagDeleted: () => () => {},
  onTagNotesChanged: () => () => {}
}))

beforeEach(() => {
  listItems.mockResolvedValue({
    success: true,
    items: [
      {
        id: 't1',
        kind: 'task',
        title: 'Ali ile 1:1',
        emoji: null,
        path: null,
        tags: ['meetings'],
        container: 'Project X',
        created: '2026-07-20T00:00:00Z',
        modified: '2026-07-22T00:00:00Z'
      }
    ]
  })
})

describe('useTagItems', () => {
  it('adapts a task into a table row', async () => {
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const row = result.current.items[0]
    expect(row.kind).toBe('task')
    expect(row.folder).toBe('Project X')
    expect(row.path).toBe('/tasks/t1')
    expect(row.wordCount).toBe(0)
  })

  it('reports the total', async () => {
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.total).toBe(1))
  })

  it('surfaces a failure as an error string', async () => {
    listItems.mockResolvedValue({ success: false, error: 'boom' })
    const { result } = renderHook(() => useTagItems({ tag: 'meetings' }))
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
