import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  GRAPH_VIEW_STATE_DEFAULTS,
  MAX_SAVED_GRAPH_VIEWS,
  type GraphViewsSettings,
  type GraphViewsSettingsPatch
} from '@memry/contracts/graph-api'
import { GRAPH_VIEWS_KEY, useGraphViews } from './use-graph-views'

let stored: GraphViewsSettings
const getGraphViews = vi.fn(async () => stored)
const setGraphViews = vi.fn(async (patch: GraphViewsSettingsPatch) => {
  stored = { ...stored, ...patch }
  return stored
})

const originalApi = window.api

beforeEach(() => {
  stored = { views: [], lastState: null }
  getGraphViews.mockClear()
  setGraphViews.mockClear()
  window.api = {
    ...originalApi,
    settings: { ...originalApi?.settings, getGraphViews, setGraphViews }
  } as typeof window.api
})

afterEach(() => {
  window.api = originalApi
})

function renderGraphViews() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, ...renderHook(() => useGraphViews(), { wrapper }) }
}

const tasksOff = {
  ...GRAPH_VIEW_STATE_DEFAULTS,
  filters: { ...GRAPH_VIEW_STATE_DEFAULTS.filters, showTasks: false }
}

describe('useGraphViews', () => {
  it('saves, updates and deletes views through settings IPC', async () => {
    const { result } = renderGraphViews()
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.saveView('   ', GRAPH_VIEW_STATE_DEFAULTS, 'forceatlas2')).toBeNull()

    let savedId = ''
    act(() => {
      savedId = result.current.saveView(' Work ', GRAPH_VIEW_STATE_DEFAULTS, 'forceatlas2')!.id
    })
    await waitFor(() => expect(result.current.views).toHaveLength(1))
    expect(result.current.views[0]).toMatchObject({ id: savedId, name: 'Work' })

    act(() => result.current.updateView(savedId, tasksOff, 'circular'))
    await waitFor(() => expect(result.current.views[0].layout).toBe('circular'))
    expect(result.current.views[0].state).toEqual(tasksOff)

    act(() => result.current.deleteView(savedId))
    await waitFor(() => expect(result.current.views).toHaveLength(0))
    expect(setGraphViews).toHaveBeenCalledTimes(3)
  })

  it('remembers the last state without touching saved views', async () => {
    const { result } = renderGraphViews()
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => result.current.rememberState(tasksOff))
    await waitFor(() => expect(result.current.lastState).toEqual(tasksOff))
    expect(setGraphViews).toHaveBeenCalledWith({ lastState: tasksOff })
  })

  it('refuses to save past the cap', async () => {
    stored = {
      views: Array.from({ length: MAX_SAVED_GRAPH_VIEWS }, (_, i) => ({
        id: `v${i}`,
        name: `V${i}`,
        state: GRAPH_VIEW_STATE_DEFAULTS,
        createdAt: '',
        updatedAt: ''
      })),
      lastState: null
    }
    const { result } = renderGraphViews()
    await waitFor(() => expect(result.current.views).toHaveLength(MAX_SAVED_GRAPH_VIEWS))
    expect(result.current.saveView('One more', GRAPH_VIEW_STATE_DEFAULTS, 'forceatlas2')).toBeNull()
  })

  it('rolls back an optimistic write that failed', async () => {
    setGraphViews.mockRejectedValueOnce(new Error('no vault'))
    const { result, queryClient } = renderGraphViews()
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => result.current.rememberState(tasksOff))
    await waitFor(() =>
      expect(queryClient.getQueryData<GraphViewsSettings>(GRAPH_VIEWS_KEY)?.lastState).toBeNull()
    )
  })
})
