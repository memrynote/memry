import { useMemo, useCallback, useEffect, useRef, useState } from 'react'
import {
  GRAPH_LAYOUT_GLOBAL_KEY,
  GRAPH_VIEW_STATE_DEFAULTS,
  type GraphDataResponse,
  type GraphLayoutNode,
  type GraphViewState,
  type SavedGraphView
} from '@memry/contracts/graph-api'
import { Loader2, AlertCircle, Network, Link2, Lightbulb } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { hasWebGLSupport } from '@/lib/webgl-support'
import { useGraphData, useGraphReactivity } from '@/hooks/use-graph-data'
import { isGraphFiltered, useGraphFilters } from '@/hooks/use-graph-filters'
import { useGraphSettings } from '@/hooks/use-graph-settings'
import { useGraphLayout, useGraphLayoutActions } from '@/hooks/use-graph-layout'
import { useGraphViews } from '@/hooks/use-graph-views'
import { useTagCategories } from '@/hooks/use-tag-categories'
import { buildGraphCategoryIndex, categoryRankOf } from '@/lib/graph-categories'
import { useT } from '@memry/i18n/renderer'
import { GraphCanvas } from './graph-canvas'
import { GraphControlPanel, type GraphCategoryRow } from './graph-control-panel'
import { GraphViewsMenu } from './graph-views-menu'
import { GraphRenderUnavailable } from './graph-render-unavailable'

/** How long a view-state change settles before it is remembered for the next graph tab. */
const REMEMBER_STATE_DEBOUNCE_MS = 400

const ENTITY_LABEL_KEYS = {
  note: { one: 'entity.note', other: 'entity.notes' },
  journal: { one: 'entity.journal', other: 'entity.journals' },
  task: { one: 'entity.task', other: 'entity.tasks' },
  project: { one: 'entity.project', other: 'entity.projects' },
  tag: { one: 'entity.tag', other: 'entity.tags' },
  orphan: { one: 'entity.orphan', other: 'entity.orphans' }
} as const

export function GraphPage({ onClose }: { onClose?: () => void } = {}): React.JSX.Element {
  const [webglAvailable] = useState(() => hasWebGLSupport())

  if (!webglAvailable) return <GraphRenderUnavailable onClose={onClose} />

  return <GraphPageContent onClose={onClose} />
}

function GraphPageContent({ onClose }: { onClose?: () => void }): React.JSX.Element {
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
  const graphViews = useGraphViews()
  const { categories, isLoading: categoriesLoading } = useTagCategories()
  const { layout: savedLayout, isLoading: isLayoutLoading } =
    useGraphLayout(GRAPH_LAYOUT_GLOBAL_KEY)
  const { save: saveLayout, clear: clearLayout } = useGraphLayoutActions(GRAPH_LAYOUT_GLOBAL_KEY)
  // Re-layout remounts the canvas: a fresh graph, scattered seeds, no pins.
  const [layoutEpoch, setLayoutEpoch] = useState(0)

  // Remount before clearing: the old canvas stops saving the moment it unmounts,
  // and the new one only saves once it rests, so its write queues after the clear.
  const handleRelayout = useCallback(async () => {
    setLayoutEpoch((epoch) => epoch + 1)
    await clearLayout()
  }, [clearLayout])

  if (isLoading || graphViews.isLoading || categoriesLoading || isLayoutLoading) {
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

  return (
    <GraphWorkspace
      data={data}
      graphViews={graphViews}
      categories={categories}
      layoutEpoch={layoutEpoch}
      savedLayout={layoutEpoch === 0 ? (savedLayout?.nodes ?? null) : null}
      onLayoutChange={saveLayout}
      onRelayout={handleRelayout}
      onClose={onClose}
    />
  )
}

function GraphWorkspace({
  data,
  graphViews,
  categories,
  layoutEpoch,
  savedLayout,
  onLayoutChange,
  onRelayout,
  onClose
}: {
  data: GraphDataResponse
  graphViews: ReturnType<typeof useGraphViews>
  categories: ReturnType<typeof useTagCategories>['categories']
  layoutEpoch: number
  savedLayout: Readonly<Record<string, GraphLayoutNode>> | null
  onLayoutChange: (nodes: Record<string, GraphLayoutNode>) => void
  onRelayout: () => Promise<void>
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useT('graph')
  const { views, lastState, saveView, updateView, deleteView, rememberState } = graphViews
  // A graph tab with nothing stored — a fresh one — starts where the last graph
  // tab left off. Frozen at mount: later writes of `lastState` come from this
  // very tab and must not re-seed it.
  const [initialState] = useState<GraphViewState>(() => lastState ?? GRAPH_VIEW_STATE_DEFAULTS)
  const {
    viewState,
    activeViewId,
    filterState: storedFilters,
    dispatch,
    setColorBy,
    toggleCollapsed,
    applyView
  } = useGraphFilters(initialState)
  const { settings: graphSettings, updateSettings } = useGraphSettings()

  // Remember the state for the next freshly opened graph tab. Debounced, and
  // flushed on unmount so closing the tab right after a change keeps it.
  const pendingStateRef = useRef<GraphViewState | null>(null)
  useEffect(() => {
    pendingStateRef.current = viewState
    const timer = setTimeout(() => {
      if (pendingStateRef.current) rememberState(pendingStateRef.current)
      pendingStateRef.current = null
    }, REMEMBER_STATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [viewState, rememberState])
  useEffect(
    () => () => {
      // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent -- unmount flush of a debounced settings write: the ref holds the value, not a DOM node
      if (pendingStateRef.current) rememberState(pendingStateRef.current)
    },
    [rememberState]
  )

  // A focus restored from an earlier session may point at a node that has
  // since been deleted. Focusing on it would hide the whole graph.
  const filterState = useMemo(() => {
    const focus = storedFilters.focusNodeId
    if (!focus || data.nodes.some((n) => n.id === focus)) return storedFilters
    return { ...storedFilters, focusNodeId: null }
  }, [storedFilters, data])

  const categoryIndex = useMemo(() => buildGraphCategoryIndex(categories), [categories])

  const categoryRows = useMemo<GraphCategoryRow[]>(() => {
    const counts = new Array<number>(categoryIndex.categories.length).fill(0)
    for (const node of data.nodes) {
      const rank = categoryRankOf(node.id, node.tags, categoryIndex.rankByTag)
      if (rank !== undefined) counts[rank] += 1
    }
    return categoryIndex.categories.map((category, index) => ({
      ...category,
      count: counts[index]
    }))
  }, [categoryIndex, data])

  const activeView = useMemo(
    () => views.find((view) => view.id === activeViewId) ?? null,
    [views, activeViewId]
  )

  const isActiveViewModified = useMemo(() => {
    if (!activeView) return false
    if (activeView.layout !== undefined && activeView.layout !== graphSettings.layout) return true
    return JSON.stringify(activeView.state) !== JSON.stringify(viewState)
  }, [activeView, viewState, graphSettings.layout])

  const handleApplyView = useCallback(
    (view: SavedGraphView) => {
      applyView(view.state, view.id)
      if (view.layout && view.layout !== graphSettings.layout) {
        updateSettings({ layout: view.layout })
      }
    },
    [applyView, graphSettings.layout, updateSettings]
  )

  const handleSaveAs = useCallback(
    (name: string): boolean => {
      const saved = saveView(name, viewState, graphSettings.layout)
      if (!saved) return false
      applyView(viewState, saved.id)
      return true
    },
    [saveView, viewState, graphSettings.layout, applyView]
  )

  const handleUpdateView = useCallback(
    (view: SavedGraphView) => updateView(view.id, viewState, graphSettings.layout),
    [updateView, viewState, graphSettings.layout]
  )

  const handleDeleteView = useCallback(
    (view: SavedGraphView) => {
      deleteView(view.id)
      if (view.id === activeViewId) applyView(viewState, null)
    },
    [deleteView, activeViewId, applyView, viewState]
  )

  const focusLabel = useMemo(() => {
    if (!filterState.focusNodeId) return null
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
          key={layoutEpoch}
          data={data}
          savedLayout={savedLayout}
          onLayoutChange={onLayoutChange}
          filterState={filterState}
          graphSettings={graphSettings}
          viewState={viewState}
          categoryIndex={categoryIndex}
          onFocusNode={handleFocusNode}
          onToggleCategory={toggleCollapsed}
          onClose={onClose}
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
        isFiltered={isGraphFiltered(filterState)}
        focusLabel={focusLabel}
        settings={graphSettings}
        updateSettings={updateSettings}
        onRelayout={onRelayout}
        viewsMenu={
          <GraphViewsMenu
            views={views}
            activeView={activeView}
            isModified={isActiveViewModified}
            onApply={handleApplyView}
            onSaveAs={handleSaveAs}
            onUpdate={handleUpdateView}
            onDelete={handleDeleteView}
          />
        }
        colorBy={viewState.colorBy}
        onColorByChange={setColorBy}
        categories={categoryRows}
        collapsedCategoryIds={viewState.collapsedCategoryIds}
        onToggleCategory={toggleCollapsed}
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
