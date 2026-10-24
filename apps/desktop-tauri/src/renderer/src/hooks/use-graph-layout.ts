import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  GRAPH_LAYOUT_VERSION,
  type GraphLayout,
  type GraphLayoutNode
} from '@memry/contracts/graph-api'
import { createLogger } from '@/lib/logger'

const log = createLogger('GraphLayout')

/**
 * Outside `graphKeys.all` on purpose: every note save invalidates that prefix,
 * and the layout is only read once, when the graph is built.
 */
export const graphLayoutKey = (viewKey: string) => ['graph-layout', viewKey] as const

/**
 * Saved positions for a graph view. A failed read resolves to null so the graph
 * still opens, just with a fresh arrangement. Never cached across opens: the
 * layout changes while the graph is on screen, so a reopen must read it again.
 */
export function useGraphLayout(viewKey: string): {
  layout: GraphLayout | null
  isLoading: boolean
} {
  const { data, isLoading } = useQuery<GraphLayout | null>({
    queryKey: graphLayoutKey(viewKey),
    queryFn: async () => {
      try {
        return await window.api.graph.getLayout(viewKey)
      } catch (error) {
        log.warn('Failed to load graph layout, starting fresh', error)
        return null
      }
    },
    gcTime: 0,
    staleTime: Infinity,
    retry: false
  })
  return { layout: data ?? null, isLoading }
}

/**
 * Writes are chained so a save can never land after a later save or clear and
 * resurrect an older arrangement.
 */
let writeChain: Promise<unknown> = Promise.resolve()

function enqueueWrite(write: () => Promise<unknown>): Promise<void> {
  const next = writeChain.then(write, write)
  writeChain = next.catch((error: unknown) => {
    log.warn('Failed to write graph layout', error)
  })
  return writeChain.then(() => undefined)
}

export function useGraphLayoutActions(viewKey: string): {
  save: (nodes: Record<string, GraphLayoutNode>) => void
  clear: () => Promise<void>
} {
  const queryClient = useQueryClient()

  const save = useCallback(
    (nodes: Record<string, GraphLayoutNode>) => {
      const layout: GraphLayout = { version: GRAPH_LAYOUT_VERSION, nodes }
      void enqueueWrite(() => window.api.graph.saveLayout({ viewKey, layout }))
    },
    [viewKey]
  )

  const clear = useCallback(async () => {
    await enqueueWrite(() => window.api.graph.clearLayout(viewKey))
    queryClient.setQueryData(graphLayoutKey(viewKey), null)
  }, [queryClient, viewKey])

  return useMemo(() => ({ save, clear }), [save, clear])
}
