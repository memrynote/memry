import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { SigmaContainer, useSigma } from '@react-sigma/core'
import { useTheme } from 'next-themes'
import '@react-sigma/core/lib/style.css'
import type Graph from 'graphology'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types'
import {
  buildGraphologyGraph,
  computeFocusSet,
  createGraphPositionCache,
  groupNodeId,
  keepsOwnEdgeColor,
  syncGraphologyGraph,
  tagOfTagNode,
  type BuildGraphOptions,
  type CollapsedGraphGroup,
  type GraphPositionCache
} from '@/lib/graph-builder'
import {
  categoryRankOf,
  GRAPH_GROUP_NONE_VAR,
  type GraphCategoryIndex
} from '@/lib/graph-categories'
import { graphLabelRenderedSizeThreshold } from '@/lib/graph-labels'
import {
  refreshSigmaIfMeasurable,
  SIGMA_ALLOW_INVALID_CONTAINER,
  useRepaintSigmaWhenContainerRegainsWidth
} from '@/lib/sigma-refresh'
import { hasWebGLSupport } from '@/lib/webgl-support'
import { RESTORED_ALPHA, type GraphPhysicsOptions, type NodePosition } from '@/lib/graph-physics'
import {
  LivePhysics,
  SettledPhysics,
  type LayoutChangeHandler,
  type PhysicsHandle
} from './physics-layout'
import { GraphPinMarkers } from './graph-pin-markers'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphSettings, GraphViewState } from '@memry/contracts/graph-api'
import { useTabActions } from '@/contexts/tabs'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { useGraphEdits, type GraphEdits } from '@/hooks/use-graph-edits'
import { isEditableGraphNode, type GraphRelationLink } from '@/lib/graph-edits'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { GraphEvents, type LinkDragState } from './graph-events'
import { GraphTooltip } from './graph-tooltip'
import { GraphContextMenu, type ContextMenuState } from './graph-context-menu'
import { GraphRenderUnavailable } from './graph-render-unavailable'

const ENTITY_TYPE_VISIBILITY: Record<string, keyof GraphFilterState> = {
  note: 'showNotes',
  journal: 'showJournals',
  task: 'showTasks',
  project: 'showProjects',
  tag: 'showTags'
}

function resolveGraphVar(varName: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback
}

const HOVER_FADE_IN_MS = 250
const HOVER_FADE_OUT_MS = 180

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

function lerpColor(from: string, to: string, t: number): string {
  const a = from.startsWith('#') ? from.slice(1) : from
  const b = to.startsWith('#') ? to.slice(1) : to
  const [ar, ag, ab] = [
    parseInt(a.slice(0, 2), 16),
    parseInt(a.slice(2, 4), 16),
    parseInt(a.slice(4, 6), 16)
  ]
  const [br, bg, bb] = [
    parseInt(b.slice(0, 2), 16),
    parseInt(b.slice(2, 4), 16),
    parseInt(b.slice(4, 6), 16)
  ]
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`
}

interface GraphCanvasProps {
  data: GraphDataResponse
  filterState: GraphFilterState
  graphSettings: GraphSettings
  /** Colouring and collapsed categories. Omitted means entity-type colours, nothing collapsed. */
  viewState?: Pick<GraphViewState, 'colorBy' | 'collapsedCategoryIds'>
  categoryIndex?: GraphCategoryIndex
  onFocusNode: (nodeId: string) => void
  /** A collapsed category's super-node was clicked or its menu asked to expand it. */
  onToggleCategory?: (categoryId: string) => void
  onClose?: () => void
  /** Positions to start from; read once, when the graph is built. */
  savedLayout?: Readonly<Record<string, NodePosition>> | null
  /** Called with every position when the force layout rests or a pin changes. */
  onLayoutChange?: LayoutChangeHandler
}

const RESTORED_PHYSICS_OPTIONS: GraphPhysicsOptions = { initialAlpha: RESTORED_ALPHA }
const NO_CATEGORIES: GraphCategoryIndex = { categories: [], rankByTag: new Map() }

export function GraphCanvas({
  data,
  filterState,
  graphSettings,
  viewState,
  categoryIndex = NO_CATEGORIES,
  onFocusNode,
  onToggleCategory,
  onClose,
  savedLayout,
  onLayoutChange
}: GraphCanvasProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const [webglAvailable] = useState(() => hasWebGLSupport())
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const fadeRef = useRef(0)
  const hoverTargetRef = useRef<string | null>(null)
  const physicsHandleRef = useRef<PhysicsHandle | null>(null)
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null)
  const graphEdits = useGraphEdits()
  const { t } = useT('graph')

  const handleNodeGrab = useCallback((nodeId: string) => {
    physicsHandleRef.current?.grab(nodeId)
  }, [])

  const handleNodeDrag = useCallback((nodeId: string, x: number, y: number) => {
    physicsHandleRef.current?.drag(nodeId, x, y)
  }, [])

  // A drop pins the node where it landed; a plain click leaves it as it was.
  const handleNodeRelease = useCallback((nodeId: string, moved: boolean) => {
    if (moved) physicsHandleRef.current?.pin(nodeId)
    else physicsHandleRef.current?.release(nodeId)
  }, [])

  const handleUnpin = useCallback((nodeId: string) => {
    physicsHandleRef.current?.unpin(nodeId)
  }, [])

  const [physicsOptions] = useState(() =>
    savedLayout && Object.keys(savedLayout).length > 0 ? RESTORED_PHYSICS_OPTIONS : undefined
  )

  const dimmedColor = useMemo(() => resolveGraphVar('--graph-dimmed-node', '#e4e4de'), [])

  const softEdgeColor = useMemo(() => resolveGraphVar('--graph-edge-soft', '#d5d3cd'), [])

  const labelColor = useMemo(() => resolveGraphVar('--graph-label-color', '#1a1a1a'), [])

  const colorBy = viewState?.colorBy ?? 'type'
  const collapsedIds = viewState?.collapsedCategoryIds

  // Resolved per theme: the palette is CSS variables, and graphology stores
  // plain colour strings.
  const categoryColors = useMemo(
    () => categoryIndex.categories.map((category) => resolveGraphVar(category.colorVar, '#8c8c8c')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categoryIndex, resolvedTheme]
  )
  const uncategorizedColor = useMemo(
    () => resolveGraphVar(GRAPH_GROUP_NONE_VAR, '#c4c2bc'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTheme]
  )

  const collapsedGroups = useMemo<CollapsedGraphGroup[]>(() => {
    if (!collapsedIds || collapsedIds.length === 0) return []
    const collapsed = new Set(collapsedIds)
    return categoryIndex.categories.flatMap((category, index) =>
      collapsed.has(category.id)
        ? [
            {
              id: category.id,
              label: category.label,
              color: categoryColors[index],
              tags: category.tags
            }
          ]
        : []
    )
  }, [collapsedIds, categoryIndex, categoryColors])

  const graphBuildOptions: BuildGraphOptions = useMemo(
    () => ({ showTags: graphSettings.showTagEdges, collapsedGroups }),
    [graphSettings.showTagEdges, collapsedGroups]
  )

  const { graph, revision, positionCache } = useLiveGraph(
    data,
    graphBuildOptions,
    resolvedTheme,
    savedLayout
  )

  // The physics snapshot only covers nodes on screen. Members folded into a
  // collapsed category are off screen, so without this every save while
  // collapsed would forget where they sat.
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])
  const handleLayoutChange = useMemo<LayoutChangeHandler | undefined>(() => {
    if (!onLayoutChange) return undefined
    return (positions) => {
      if (positionCache.positions.size === 0) {
        onLayoutChange(positions)
        return
      }
      const known = graphNodeIds(dataRef.current)
      const merged: Record<string, NodePosition> = {}
      for (const [id, position] of positionCache.positions) {
        if (!graph.hasNode(id) && known.has(id)) merged[id] = position
      }
      onLayoutChange({ ...merged, ...positions })
    }
  }, [onLayoutChange, positionCache, graph])

  // A focused node folded into a collapsed category is represented by its
  // super-node; focusing on a node that is not on screen at all would hide
  // the whole graph.
  const focusNodeId = useMemo(() => {
    const focus = filterState.focusNodeId
    if (!focus || graph.hasNode(focus)) return focus
    // Same rule the builder folds by: the first collapsed group sharing a tag.
    const ownTag = tagOfTagNode(focus)
    const tags = ownTag !== null ? [ownTag] : (data.nodes.find((n) => n.id === focus)?.tags ?? [])
    const group = collapsedGroups.find((candidate) => candidate.tags.some((t) => tags.includes(t)))
    return group && graph.hasNode(groupNodeId(group.id)) ? groupNodeId(group.id) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, revision, filterState.focusNodeId, data, collapsedGroups])

  const focusVisibleSet = useMemo(() => {
    if (!focusNodeId) return null
    return computeFocusSet(graph, focusNodeId, filterState.focusDepth)
    // `revision` is not read here — it marks the patch that changed the topology
    // this focus neighbourhood is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, revision, focusNodeId, filterState.focusDepth])

  const searchLower = useMemo(
    () => filterState.searchQuery.toLowerCase(),
    [filterState.searchQuery]
  )

  const categoryColorOf = useCallback(
    (node: string, tags: readonly string[] | undefined): string => {
      const rank = categoryRankOf(node, tags, categoryIndex.rankByTag)
      return rank === undefined ? uncategorizedColor : categoryColors[rank]
    },
    [categoryIndex, categoryColors, uncategorizedColor]
  )

  const nodeReducer = useCallback(
    (node: string, attrs: Record<string, unknown>): Partial<NodeDisplayData> => {
      const nodeType = attrs.nodeType as string
      const tags = attrs.tags as string[]
      const isOrphan = attrs.isOrphan as boolean
      const label = attrs.label as string
      const base = (
        colorBy === 'tag-category' && nodeType !== 'group' && !attrs.isUnresolved
          ? { ...attrs, color: categoryColorOf(node, tags) }
          : attrs
      ) as Partial<NodeDisplayData> & Record<string, unknown>

      const visKey = ENTITY_TYPE_VISIBILITY[nodeType]
      if (visKey && !filterState[visKey]) {
        return { ...base, hidden: true }
      }

      if (isOrphan && !filterState.showOrphans) {
        return { ...base, hidden: true }
      }

      if (filterState.selectedTags.length > 0) {
        const hasMatchingTag = filterState.selectedTags.some((t) => tags.includes(t))
        if (!hasMatchingTag) {
          return { ...base, hidden: true }
        }
      }

      if (focusVisibleSet && !focusVisibleSet.has(node)) {
        return { ...base, hidden: true }
      }

      if (searchLower && label) {
        const matches = label.toLowerCase().includes(searchLower)
        if (matches) {
          return {
            ...base,
            highlighted: true,
            forceLabel: true,
            zIndex: 1
          }
        }
      }

      const activeHover = hoverTargetRef.current
      const fade = fadeRef.current

      if (!activeHover || fade === 0) return base

      const isHovered = node === activeHover
      const isNeighbor =
        graph.hasNode(activeHover) && graph.hasNode(node) && graph.areNeighbors(node, activeHover)

      if (isHovered) {
        return {
          ...base,
          highlighted: true,
          forceLabel: true,
          zIndex: 1
        }
      }
      if (isNeighbor) {
        return base
      }

      const originalColor = (base.color as string) || '#999'
      return {
        ...base,
        label: fade > 0.5 ? '' : (attrs.label as string),
        color: lerpColor(originalColor, dimmedColor, fade),
        zIndex: 0
      }
    },
    [graph, filterState, focusVisibleSet, searchLower, dimmedColor, colorBy, categoryColorOf]
  )

  const edgeReducer = useCallback(
    (edge: string, attrs: Record<string, unknown>): Partial<EdgeDisplayData> => {
      if (!graph.hasEdge(edge)) return attrs as Partial<EdgeDisplayData>

      if (attrs.edgeType === 'canvas' && !filterState.showCanvasEdges) {
        return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
      }

      const [source, target] = graph.extremities(edge)

      const sourceAttrs = graph.getNodeAttributes(source)
      const targetAttrs = graph.getNodeAttributes(target)
      const sourceType = sourceAttrs.nodeType as string
      const targetType = targetAttrs.nodeType as string

      const sourceVisKey = ENTITY_TYPE_VISIBILITY[sourceType]
      const targetVisKey = ENTITY_TYPE_VISIBILITY[targetType]
      if (
        (sourceVisKey && !filterState[sourceVisKey]) ||
        (targetVisKey && !filterState[targetVisKey])
      ) {
        return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
      }

      if (focusVisibleSet && (!focusVisibleSet.has(source) || !focusVisibleSet.has(target))) {
        return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
      }

      const activeHover = hoverTargetRef.current
      const fade = fadeRef.current

      if (!activeHover || fade === 0 || !graph.hasNode(activeHover)) {
        return {
          ...(attrs as Partial<EdgeDisplayData>),
          color: keepsOwnEdgeColor(attrs) ? (attrs.color as string) : softEdgeColor,
          size: 1
        }
      }

      const connected = source === activeHover || target === activeHover
      if (connected) {
        const targetSize = ((attrs.size as number) ?? 1) + 2
        return {
          ...(attrs as Partial<EdgeDisplayData>),
          color: keepsOwnEdgeColor(attrs) ? (attrs.color as string) : softEdgeColor,
          size: 1 + (targetSize - 1) * fade
        }
      }

      return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
    },
    [graph, filterState, focusVisibleSet, softEdgeColor]
  )

  const initialSigmaSettings = useMemo(
    () => ({
      nodeReducer,
      edgeReducer,
      labelRenderedSizeThreshold: graphLabelRenderedSizeThreshold(graphSettings.showLabels),
      labelColor: { color: labelColor },
      labelSize: 12,
      defaultEdgeType: 'line' as const,
      renderEdgeLabels: false,
      minEdgeThickness: 0.5,
      ...SIGMA_ALLOW_INVALID_CONTAINER
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), [])

  const canStartLink = useCallback((nodeId: string) => isEditableGraphNode(graph, nodeId), [graph])

  const handleLinkDrop = useCallback(
    (sourceId: string, targetId: string) => {
      if (!isEditableGraphNode(graph, targetId)) {
        toast(t('edit.link-unsupported'))
        return
      }
      void graphEdits.linkNotes(sourceId, targetId, {
        source: nodeLabel(graph, sourceId, t('context-menu.untitled')),
        target: nodeLabel(graph, targetId, t('context-menu.untitled'))
      })
    },
    [graph, graphEdits, t]
  )

  if (!webglAvailable) return <GraphRenderUnavailable onClose={onClose} />

  return (
    <div className="relative h-full w-full">
      <SigmaContainer graph={graph} settings={initialSigmaSettings} className="h-full w-full">
        <SigmaSettingsSync
          graph={graph}
          nodeReducer={nodeReducer}
          edgeReducer={edgeReducer}
          showLabels={graphSettings.showLabels}
          labelColor={labelColor}
        />
        <HoverFadeAnimator
          hoveredNode={hoveredNode}
          fadeRef={fadeRef}
          hoverTargetRef={hoverTargetRef}
        />
        <LayoutManager
          layout={graphSettings.layout}
          animate={graphSettings.animateLayout}
          graph={graph}
          revision={revision}
          physicsHandleRef={physicsHandleRef}
          physicsOptions={physicsOptions}
          onLayoutChange={handleLayoutChange}
        />
        {graphSettings.layout === 'forceatlas2' && (
          <GraphPinMarkers graph={graph} color={labelColor} />
        )}
        <GraphEvents
          onHoverNode={setHoveredNode}
          onTooltipMove={setTooltipPos}
          onFocusNode={onFocusNode}
          onToggleCategory={onToggleCategory}
          onContextMenu={setContextMenu}
          onNodeGrab={handleNodeGrab}
          onNodeDrag={handleNodeDrag}
          onNodeRelease={handleNodeRelease}
          canStartLink={canStartLink}
          onLinkDrag={setLinkDrag}
          onLinkDrop={handleLinkDrop}
        />
      </SigmaContainer>
      {linkDrag && (
        <svg
          aria-hidden
          data-testid="graph-link-preview"
          className="pointer-events-none absolute inset-0 size-full text-foreground/60"
        >
          <line
            x1={linkDrag.fromX}
            y1={linkDrag.fromY}
            x2={linkDrag.x}
            y2={linkDrag.y}
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <circle cx={linkDrag.x} cy={linkDrag.y} r={3} fill="currentColor" />
        </svg>
      )}
      {hoveredNode && tooltipPos && !contextMenu && !linkDrag && (
        <GraphTooltip nodeId={hoveredNode} graph={graph} x={tooltipPos.x} y={tooltipPos.y} />
      )}
      {contextMenu && (
        <ContextMenuWithTabAction
          menu={contextMenu}
          graph={graph}
          categoryIndex={categoryIndex}
          collapsedIds={collapsedIds}
          onFocusNode={onFocusNode}
          onUnpin={handleUnpin}
          graphEdits={graphEdits}
          onToggleCategory={onToggleCategory}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  )
}

/**
 * One graphology instance for the lifetime of the canvas, patched in place as
 * data arrives.
 *
 * `SigmaContainer` recreates Sigma — and with it the WebGL context — whenever the
 * `graph` prop changes identity, and the layout restarts from a cold alpha. Every
 * note or task save invalidates the graph query, so rebuilding here meant a
 * renderer teardown and a full re-simulation per keystroke-debounce. Only a
 * remount (vault switch, tab close, reload) builds a fresh graph now.
 */
function useLiveGraph(
  data: GraphDataResponse,
  options: BuildGraphOptions,
  themeKey: string | undefined,
  savedLayout: Readonly<Record<string, NodePosition>> | null | undefined
): { graph: Graph; revision: number; positionCache: GraphPositionCache } {
  const [graph] = useState(() => buildGraphologyGraph(data, options, savedLayout))
  const [revision, setRevision] = useState(0)
  const appliedRef = useRef({ data, options, themeKey })
  // Where collapsed members sat, so expanding a category puts them back. Seeded
  // with the saved positions of nodes that start out folded into a category.
  const [positionCache] = useState(() => {
    const cache = createGraphPositionCache()
    for (const [id, position] of Object.entries(savedLayout ?? {})) {
      if (!graph.hasNode(id)) cache.positions.set(id, position)
    }
    return cache
  })

  /* eslint-disable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change,
     react-you-might-not-need-an-effect/no-event-handler,
     react-you-might-not-need-an-effect/no-chain-state-updates -- genuine external sync: the
     graphology instance sigma is bound to is mutated here, and the counter only records that it
     happened so the layout and the focus set can react. Patching during render would fire
     graphology's change events mid-render. */
  useEffect(() => {
    const applied = appliedRef.current
    // Nothing has arrived since the graph was built or last patched. `themeKey`
    // takes part because a theme flip re-resolves the CSS colour variables the
    // node and edge attributes were built from.
    if (applied.data === data && applied.options === options && applied.themeKey === themeKey) {
      return
    }
    appliedRef.current = { data, options, themeKey }
    if (syncGraphologyGraph(graph, data, options, positionCache).changed) {
      setRevision((current) => current + 1)
    }
  }, [graph, data, options, themeKey, positionCache])
  /* eslint-enable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change,
     react-you-might-not-need-an-effect/no-event-handler,
     react-you-might-not-need-an-effect/no-chain-state-updates */

  return { graph, revision, positionCache }
}

/** Every node id `data` can put on screen: entities and their `tag:` nodes. */
function graphNodeIds(data: GraphDataResponse): Set<string> {
  const ids = new Set<string>()
  for (const node of data.nodes) {
    ids.add(node.id)
    for (const tag of node.tags) ids.add(`tag:${tag}`)
  }
  return ids
}

function nodeLabel(graph: Graph, nodeId: string, fallback: string): string {
  if (!graph.hasNode(nodeId)) return fallback
  return (graph.getNodeAttribute(nodeId, 'label') as string) || fallback
}

function ContextMenuWithTabAction({
  menu,
  graph,
  categoryIndex,
  collapsedIds,
  onFocusNode,
  onUnpin,
  graphEdits,
  onToggleCategory,
  onClose
}: {
  menu: ContextMenuState
  graph: ReturnType<typeof buildGraphologyGraph>
  categoryIndex: GraphCategoryIndex
  collapsedIds: readonly string[] | undefined
  onFocusNode: (nodeId: string) => void
  onUnpin: (nodeId: string) => void
  graphEdits: GraphEdits
  onToggleCategory?: (categoryId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { openTab } = useTabActions()
  const { createNote } = useNoteMutations()
  const { t } = useT('graph')

  const handleOpenInTab = useCallback(
    (nodeId: string) => {
      if (!graph.hasNode(nodeId)) return
      const attrs = graph.getNodeAttributes(nodeId)
      const nodeType = attrs.nodeType as string
      const tabTypeMap: Record<string, string> = {
        note: 'note',
        journal: 'journal',
        task: 'tasks',
        project: 'project'
      }
      const tabType = tabTypeMap[nodeType]
      if (!tabType) return
      openTab({
        type: tabType as 'note' | 'journal' | 'tasks' | 'project',
        title: (attrs.label as string) || t('context-menu.untitled'),
        icon:
          tabType === 'note'
            ? 'file-text'
            : tabType === 'journal'
              ? 'book-open'
              : tabType === 'project'
                ? 'folder'
                : 'list-checks',
        path: `/${nodeType}/${nodeId}`,
        entityId: nodeId,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [graph, openTab, t]
  )

  const handleCreateNote = useCallback(
    async (title: string) => {
      const result = await createNote.mutateAsync({ title })
      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title,
          icon: 'file-text',
          path: `/notes/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    },
    [createNote, openTab]
  )

  const untitled = t('context-menu.untitled')
  // A super-node offers "Expand"; a node whose category is expanded offers
  // "Collapse <category>".
  const categoryAction = useMemo(() => {
    if (!onToggleCategory || !graph.hasNode(menu.nodeId)) return null
    const attrs = graph.getNodeAttributes(menu.nodeId)
    if (attrs.nodeType === 'group') {
      return {
        categoryId: attrs.categoryId as string,
        label: attrs.groupLabel as string,
        collapsed: true
      }
    }
    const rank = categoryRankOf(menu.nodeId, attrs.tags as string[], categoryIndex.rankByTag)
    const category = rank === undefined ? undefined : categoryIndex.categories[rank]
    if (!category || collapsedIds?.includes(category.id)) return null
    return { categoryId: category.id, label: category.label, collapsed: false }
  }, [graph, menu.nodeId, categoryIndex, collapsedIds, onToggleCategory])

  return (
    <GraphContextMenu
      menu={menu}
      graph={graph}
      categoryAction={categoryAction}
      onToggleCategory={onToggleCategory}
      onFocusNode={onFocusNode}
      onOpenInTab={handleOpenInTab}
      onCreateNote={(...args) => void handleCreateNote(...args)}
      onUnpin={onUnpin}
      onLinkTo={(sourceId, targetId) =>
        void graphEdits.linkNotes(sourceId, targetId, {
          source: nodeLabel(graph, sourceId, untitled),
          target: nodeLabel(graph, targetId, untitled)
        })
      }
      onAddTag={(nodeId, tag) => void graphEdits.addTag(nodeId, tag)}
      onUnlink={(link: GraphRelationLink) =>
        void graphEdits.unlinkNotes(link.sourceId, link.targetId, {
          source: nodeLabel(graph, link.sourceId, untitled),
          target: nodeLabel(graph, link.targetId, untitled)
        })
      }
      onClose={onClose}
    />
  )
}

function HoverFadeAnimator({
  hoveredNode,
  fadeRef,
  hoverTargetRef
}: {
  hoveredNode: string | null
  fadeRef: React.MutableRefObject<number>
  hoverTargetRef: React.MutableRefObject<string | null>
}): null {
  const sigma = useSigma()
  const animRef = useRef<number | null>(null)

  useEffect(() => {
    if (hoveredNode) {
      hoverTargetRef.current = hoveredNode
    }

    const goal = hoveredNode ? 1 : 0
    const startFade = fadeRef.current

    if (startFade === goal) {
      refreshSigmaIfMeasurable(sigma)
      return
    }

    const startTime = performance.now()
    const duration = hoveredNode ? HOVER_FADE_IN_MS : HOVER_FADE_OUT_MS

    const tick = (now: number): void => {
      const t = Math.min((now - startTime) / duration, 1)
      fadeRef.current = startFade + (goal - startFade) * easeOutQuad(t)
      refreshSigmaIfMeasurable(sigma)

      if (t < 1) {
        animRef.current = requestAnimationFrame(tick)
      } else {
        animRef.current = null
        if (!hoveredNode) {
          hoverTargetRef.current = null
          refreshSigmaIfMeasurable(sigma)
        }
      }
    }

    if (animRef.current !== null) cancelAnimationFrame(animRef.current)
    animRef.current = requestAnimationFrame(tick)

    return () => {
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current)
        animRef.current = null
      }
    }
  }, [hoveredNode, sigma, fadeRef, hoverTargetRef])

  return null
}

function SigmaSettingsSync({
  graph,
  nodeReducer,
  edgeReducer,
  showLabels,
  labelColor
}: {
  graph: Graph
  nodeReducer: (node: string, attrs: Record<string, unknown>) => Partial<NodeDisplayData>
  edgeReducer: (edge: string, attrs: Record<string, unknown>) => Partial<EdgeDisplayData>
  showLabels: boolean
  labelColor: string
}): null {
  const sigma = useSigma()
  useRepaintSigmaWhenContainerRegainsWidth(sigma)

  // SigmaContainer kills and recreates Sigma whenever the `graph` prop changes.
  // React runs child effects before the container's create effect, so useSigma()
  // can still hand us the OLD, killed instance. kill() empties nodePrograms but
  // keeps the graph reference, so any setSetting here schedules a refresh+render
  // that throws on the next frame ("nodePrograms[circle] is undefined"). The live
  // instance is the one holding the graph we rendered with; skip anything else.
  // Once the container commits the new Sigma, these effects re-run and apply.

  useEffect(() => {
    if (sigma.getGraph() !== graph) return
    sigma.setSetting('nodeReducer', nodeReducer)
  }, [sigma, graph, nodeReducer])

  useEffect(() => {
    if (sigma.getGraph() !== graph) return
    sigma.setSetting('edgeReducer', edgeReducer)
  }, [sigma, graph, edgeReducer])

  useEffect(() => {
    if (sigma.getGraph() !== graph) return
    sigma.setSetting('labelRenderedSizeThreshold', graphLabelRenderedSizeThreshold(showLabels))
  }, [sigma, graph, showLabels])

  useEffect(() => {
    if (sigma.getGraph() !== graph) return
    sigma.setSetting('labelColor', { color: labelColor })
  }, [sigma, graph, labelColor])

  return null
}

function LayoutManager({
  layout,
  animate,
  graph,
  revision,
  physicsHandleRef,
  physicsOptions,
  onLayoutChange
}: {
  layout: GraphSettings['layout']
  animate: boolean
  graph: Graph
  revision: number
  physicsHandleRef: React.MutableRefObject<PhysicsHandle | null>
  physicsOptions: GraphPhysicsOptions | undefined
  onLayoutChange: LayoutChangeHandler | undefined
}): React.JSX.Element | null {
  useEffect(() => {
    if (layout === 'circular') {
      applyCircularLayout(graph)
    } else if (layout === 'random') {
      applyRandomLayout(graph)
    }
    // A patch can add nodes the static layouts have never placed.
  }, [layout, graph, revision])

  if (layout !== 'forceatlas2') return null

  return animate ? (
    <LivePhysics
      graph={graph}
      handleRef={physicsHandleRef}
      revision={revision}
      options={physicsOptions}
      onLayoutChange={onLayoutChange}
    />
  ) : (
    <SettledPhysics
      graph={graph}
      handleRef={physicsHandleRef}
      revision={revision}
      options={physicsOptions}
      onLayoutChange={onLayoutChange}
    />
  )
}

function applyCircularLayout(graph: Graph): void {
  const nodes = graph.nodes()
  const count = nodes.length
  if (count === 0) return
  const radius = 100 + count * 3
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / count
    graph.setNodeAttribute(node, 'x', Math.cos(angle) * radius)
    graph.setNodeAttribute(node, 'y', Math.sin(angle) * radius)
  })
}

function applyRandomLayout(graph: Graph): void {
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'x', (Math.random() - 0.5) * 1000)
    graph.setNodeAttribute(node, 'y', (Math.random() - 0.5) * 1000)
  })
}
