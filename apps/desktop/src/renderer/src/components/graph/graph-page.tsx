import { useMemo, useCallback, useEffect } from 'react'
import { Loader2, AlertCircle, Network, Link2, Lightbulb } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useGraphData, useGraphReactivity } from '@/hooks/use-graph-data'
import { useGraphFilters } from '@/hooks/use-graph-filters'
import { useGraphSettings } from '@/hooks/use-graph-settings'
import { useT } from '@memry/i18n/renderer'
import { GraphCanvas } from './graph-canvas'
import { GraphControlPanel } from './graph-control-panel'

const ENTITY_LABEL_KEYS = {
  note: { one: 'entity.note', other: 'entity.notes' },
  journal: { one: 'entity.journal', other: 'entity.journals' },
  task: { one: 'entity.task', other: 'entity.tasks' },
  project: { one: 'entity.project', other: 'entity.projects' },
  tag: { one: 'entity.tag', other: 'entity.tags' },
  orphan: { one: 'entity.orphan', other: 'entity.orphans' }
} as const

export function GraphPage(): React.JSX.Element {
  const { t } = useT('graph')
  useEffect(() => {
    void trackTelemetry('graph_opened', { surface: 'graph', action: 'opened' })
  }, [])
  const { data, isLoading, error, refetch } = useGraphData()
  // React Query catches the IPC rejection, so the global unhandledrejection
  // net never sees a graph load failure — report it when the error state lands.
  useEffect(() => {
    if (error) trackRendererError('graph_load', error)
  }, [error])
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
      .map(([type, count]) => {
        const labelKeys = ENTITY_LABEL_KEYS[type as keyof typeof ENTITY_LABEL_KEYS]
        const label = labelKeys
          ? t(count === 1 ? labelKeys.one : labelKeys.other)
          : count === 1
            ? type
            : `${type}s`
        return t('summary.node-type-count', { count, label })
      })
      .join(', ')
  }, [data, t])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Loader2 className="size-8 text-muted-foreground/50 animate-spin" />
        <p className="text-sm text-muted-foreground/60 font-serif">{t('page.loading')}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="size-8 text-destructive/60" />
        <p className="text-sm text-destructive/80 font-serif">{t('page.load-failed')}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t('page.try-again')}
        </Button>
      </div>
    )
  }

  if (!data || (data.nodes.length === 0 && data.edges.length === 0)) {
    return <GraphEmptyState />
  }

  const nodeCount = data.nodes.length
  const edgeCount = data.edges.length
  const graphAriaLabel = t('page.aria-label', {
    nodeCount,
    edgeCount,
    summary: nodeSummary || 'none'
  })

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
        <ul className="sr-only" aria-label={t('page.nodes-list-label')}>
          {data.nodes.map((node) => {
            const labelKeys = ENTITY_LABEL_KEYS[node.type as keyof typeof ENTITY_LABEL_KEYS]
            const type = labelKeys ? t(labelKeys.one) : node.type
            return <li key={node.id}>{t('page.node-list-item', { label: node.label, type })}</li>
          })}
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
  const { t } = useT('graph')

  return (
    <output className="flex h-full flex-col items-center justify-center" aria-live="polite">
      <div className="max-w-sm text-center space-y-6">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-cyan/10">
          <Network className="size-7 text-accent-cyan" strokeWidth={1.5} />
        </div>

        <div className="space-y-2">
          <h2 className="text-lg font-medium text-foreground">{t('empty.title')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">{t('empty.description')}</p>
        </div>

        <div className="space-y-3 text-start">
          <div className="flex items-start gap-3 rounded-md border border-border/50 p-3">
            <Link2 className="size-4 mt-0.5 text-accent-cyan shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">{t('empty.link-title')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('empty.link-description')}</p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-md border border-border/50 p-3">
            <Lightbulb className="size-4 mt-0.5 text-accent-orange shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">{t('empty.discover-title')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('empty.discover-description')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </output>
  )
}
