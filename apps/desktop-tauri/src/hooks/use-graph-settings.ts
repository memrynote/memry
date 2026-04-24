import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GRAPH_SETTINGS_DEFAULTS } from '@memry/contracts/graph-api'
import type { GraphSettings } from '@memry/contracts/graph-api'
import { invoke } from '@/lib/ipc/invoke'

const GRAPH_SETTINGS_KEY = ['settings', 'graph'] as const

export function useGraphSettings(): {
  settings: GraphSettings
  updateSettings: (updates: Partial<GraphSettings>) => void
  isLoading: boolean
} {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: GRAPH_SETTINGS_KEY,
    queryFn: () => invoke<GraphSettings>('settings_get_graph_settings'),
    staleTime: Infinity
  })

  const mutation = useMutation({
    mutationFn: (updates: Partial<GraphSettings>) =>
      invoke<{ success: boolean; error?: string }>(
        'settings_set_graph_settings',
        updates as unknown as Record<string, unknown>
      ),
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: GRAPH_SETTINGS_KEY })
      const previous = queryClient.getQueryData<GraphSettings>(GRAPH_SETTINGS_KEY)
      queryClient.setQueryData<GraphSettings>(GRAPH_SETTINGS_KEY, (old) => ({
        ...(old ?? GRAPH_SETTINGS_DEFAULTS),
        ...updates
      }))
      return { previous }
    },
    onError: (_err, _updates, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GRAPH_SETTINGS_KEY, context.previous)
      }
    }
  })

  const settings: GraphSettings = data ?? GRAPH_SETTINGS_DEFAULTS

  return {
    settings,
    updateSettings: mutation.mutate,
    isLoading
  }
}
