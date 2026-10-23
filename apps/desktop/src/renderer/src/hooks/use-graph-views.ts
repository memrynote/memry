/**
 * Saved graph views and the last-used graph view state, read from and written
 * to the vault's `graphViews` settings group through IPC.
 *
 * Device-local, like the rest of the graph settings: nothing here syncs.
 *
 * @module hooks/use-graph-views
 */

import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  GRAPH_VIEWS_SETTINGS_DEFAULTS,
  MAX_SAVED_GRAPH_VIEWS,
  type GraphSettings,
  type GraphViewState,
  type GraphViewsSettings,
  type GraphViewsSettingsPatch,
  type SavedGraphView
} from '@memry/contracts/graph-api'

export const GRAPH_VIEWS_KEY = ['settings', 'graphViews'] as const

export interface UseGraphViewsResult {
  views: SavedGraphView[]
  lastState: GraphViewState | null
  isLoading: boolean
  /** Append a named view. Returns the new view, or null when the name is empty or the list is full. */
  saveView: (
    name: string,
    state: GraphViewState,
    layout: GraphSettings['layout']
  ) => SavedGraphView | null
  /** Overwrite a view's state and layout with the current ones, keeping its name. */
  updateView: (id: string, state: GraphViewState, layout: GraphSettings['layout']) => void
  deleteView: (id: string) => void
  /** Remember the state a freshly opened graph tab should start from. */
  rememberState: (state: GraphViewState) => void
}

function newViewId(): string {
  return `graphview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function useGraphViews(): UseGraphViewsResult {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: GRAPH_VIEWS_KEY,
    queryFn: () => window.api.settings.getGraphViews(),
    staleTime: Infinity
  })

  const settings = data ?? GRAPH_VIEWS_SETTINGS_DEFAULTS

  const { mutate } = useMutation({
    mutationFn: (patch: GraphViewsSettingsPatch) => window.api.settings.setGraphViews(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: GRAPH_VIEWS_KEY })
      const previous = queryClient.getQueryData<GraphViewsSettings>(GRAPH_VIEWS_KEY)
      queryClient.setQueryData<GraphViewsSettings>(GRAPH_VIEWS_KEY, (old) => ({
        ...(old ?? GRAPH_VIEWS_SETTINGS_DEFAULTS),
        ...patch
      }))
      return { previous }
    },
    onError: (_err, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(GRAPH_VIEWS_KEY, context.previous)
    }
  })

  const views = settings.views

  const saveView = useCallback<UseGraphViewsResult['saveView']>(
    (name, state, layout) => {
      const trimmed = name.trim()
      if (trimmed === '' || views.length >= MAX_SAVED_GRAPH_VIEWS) return null
      const now = new Date().toISOString()
      const view: SavedGraphView = {
        id: newViewId(),
        name: trimmed,
        state,
        layout,
        createdAt: now,
        updatedAt: now
      }
      mutate({ views: [...views, view] })
      return view
    },
    [mutate, views]
  )

  const updateView = useCallback<UseGraphViewsResult['updateView']>(
    (id, state, layout) => {
      const now = new Date().toISOString()
      mutate({
        views: views.map((view) =>
          view.id === id ? { ...view, state, layout, updatedAt: now } : view
        )
      })
    },
    [mutate, views]
  )

  const deleteView = useCallback(
    (id: string) => mutate({ views: views.filter((view) => view.id !== id) }),
    [mutate, views]
  )

  const rememberState = useCallback(
    (state: GraphViewState) => mutate({ lastState: state }),
    [mutate]
  )

  return {
    views,
    lastState: settings.lastState,
    isLoading,
    saveView,
    updateView,
    deleteView,
    rememberState
  }
}
