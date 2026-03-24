import { useMemo, useCallback } from 'react'
import { Loader2, AlertCircle, Network, Link2, Lightbulb } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { useGraphData, useGraphReactivity } from '@/hooks/use-graph-data'
import { useGraphFilters } from '@/hooks/use-graph-filters'
import { useGraphSettings } from '@/hooks/use-graph-settings'
import { GraphCanvas } from './graph-canvas'
import { GraphControlPanel } from './graph-control-panel'

export function GraphPage(): React.JSX.Element {
  const { data, isLoading, error, refetch } = useGraphData()
  useGraphReactivity()
  const { filterState, dispatch, isFiltered } = useGraphFilters()
  const { settings: graphSettings, updateSettings } = useGraphSettings()

  const focusLabel = useMemo(() => {
    if (!filterState.focusNodeId || !data) return null
    const node = data.nodes.find((n) => n.id === filterState.focusNodeId)
    return node?.label ?? null
  }, [filterState.focusNodeId, data])

  const handleFocusNode = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'SET_FOCUS_NODE', nodeId })
    },
    [dispatch]
  )

  const nodeSummary = useMemo(() => {
    if (!data?.nodes) return ''
    const counts: Record<string, number> = {}
    data.nodes.forEach((n) => {
      counts[n.type] = (counts[n.type] ?? 0) + 1
    })
    return Object.entries(counts)
      .map(([type, count]) => `${count} ${type}${count !== 1 ? 's' : ''}`)
      .join(', ')
  }, [data?.nodes])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
        <p className="text-sm text-muted-foreground/60 font-serif">Loading graph...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="size-8 text-destructive/60" />
        <p className="text-sm text-destructive/80 font-serif">Failed to load graph data</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    )
  }

  if (!data || (data.nodes.length === 0 && data.edges.length === 0)) {
    return <GraphEmptyState />
  }

  const nodeCount = data.nodes.length
  const edgeCount = data.edges.length
  const graphAriaLabel = `Knowledge graph with ${nodeCount} node${nodeCount !== 1 ? 's' : ''} and ${edgeCount} connection${edgeCount !== 1 ? 's' : ''}${nodeSummary ? `: ${nodeSummary}` : ''}.`

  return (
    <div className="relative h-full w-full">
      <div role="img" aria-label={graphAriaLabel} className="h-full w-full">
        <GraphCanvas
          data={data}
          filterState={filterState}
          graphSettings={graphSettings}
          onFocusNode={handleFocusNode}
        />
        {/* Visually-hidden node list for screen readers */}
        <ul className="sr-only" aria-label="Graph nodes">
          {data.nodes.map((node) => (
            <li key={node.id}>
              {node.label} ({node.type})
            </li>
          ))}
        </ul>
      </div>
      <GraphControlPanel
        filterState={filterState}
        dispatch={dispatch}
        isFiltered={isFiltered}
        focusLabel={focusLabel}
        settings={graphSettings}
        updateSettings={updateSettings}
      />
    </div>
  )
}

function GraphEmptyState(): React.JSX.Element {
  return (
    <div
      className="flex h-full flex-col items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <div className="max-w-sm text-center space-y-6">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-cyan/10">
          <Network className="size-7 text-accent-cyan" strokeWidth={1.5} />
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-medium text-foreground">Your knowledge graph</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Connections between your notes, tasks, and projects will appear here as an interactive
            graph.
          </p>
        </div>

        <div className="space-y-3 text-left">
          <div className="flex items-start gap-3 rounded-md border border-border/50 p-3">
            <Link2 className="size-4 mt-0.5 text-accent-cyan shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">Link your notes</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use [[wikilinks]] to connect ideas across notes
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border border-border/50 p-3">
            <Lightbulb className="size-4 mt-0.5 text-accent-orange shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">Discover patterns</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                As connections grow, clusters and themes will emerge naturally
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
