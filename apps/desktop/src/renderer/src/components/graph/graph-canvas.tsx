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
  syncGraphologyGraph,
  type BuildGraphOptions
} from '@/lib/graph-builder'
import { LivePhysics, SettledPhysics, type PhysicsHandle } from './physics-layout'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphSettings } from '@memry/contracts/graph-api'
import { useTabActions } from '@/contexts/tabs'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { useT } from '@memry/i18n/renderer'
import { GraphEvents } from './graph-events'
import { GraphTooltip } from './graph-tooltip'
import { GraphContextMenu, type ContextMenuState } from './graph-context-menu'

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
  onFocusNode: (nodeId: string) => void
}

export function GraphCanvas({
  data,
  filterState,
  graphSettings,
  onFocusNode
}: GraphCanvasProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const fadeRef = useRef(0)
  const hoverTargetRef = useRef<string | null>(null)
  const physicsHandleRef = useRef<PhysicsHandle | null>(null)

  const handleNodeGrab = useCallback((nodeId: string) => {
    physicsHandleRef.current?.grab(nodeId)
  }, [])

  const handleNodeDrag = useCallback((nodeId: string, x: number, y: number) => {
    physicsHandleRef.current?.drag(nodeId, x, y)
  }, [])

  const handleNodeRelease = useCallback((nodeId: string) => {
    physicsHandleRef.current?.release(nodeId)
  }, [])

  const dimmedColor = useMemo(() => resolveGraphVar('--graph-dimmed-node', '#e4e4de'), [])

  const softEdgeColor = useMemo(() => resolveGraphVar('--graph-edge-soft', '#d5d3cd'), [])

  const labelColor = useMemo(() => resolveGraphVar('--graph-label-color', '#1a1a1a'), [])

  const graphBuildOptions: BuildGraphOptions = useMemo(
    () => ({ showTags: graphSettings.showTagEdges }),
    [graphSettings.showTagEdges]
  )

  const { graph, revision } = useLiveGraph(data, graphBuildOptions, resolvedTheme)

  const focusVisibleSet = useMemo(() => {
    if (!filterState.focusNodeId) return null
    return computeFocusSet(graph, filterState.focusNodeId, filterState.focusDepth)
    // `revision` is not read here — it marks the patch that changed the topology
    // this focus neighbourhood is derived from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, revision, filterState.focusNodeId, filterState.focusDepth])

  const searchLower = useMemo(
    () => filterState.searchQuery.toLowerCase(),
    [filterState.searchQuery]
  )

  const nodeReducer = useCallback(
    (node: string, attrs: Record<string, unknown>): Partial<NodeDisplayData> => {
      const nodeType = attrs.nodeType as string
      const tags = attrs.tags as string[]
      const isOrphan = attrs.isOrphan as boolean
      const label = attrs.label as string

      const visKey = ENTITY_TYPE_VISIBILITY[nodeType]
      if (visKey && !filterState[visKey]) {
        return { ...(attrs as Partial<NodeDisplayData>), hidden: true }
      }

      if (isOrphan && !filterState.showOrphans) {
        return { ...(attrs as Partial<NodeDisplayData>), hidden: true }
      }

      if (filterState.selectedTags.length > 0) {
        const hasMatchingTag = filterState.selectedTags.some((t) => tags.includes(t))
        if (!hasMatchingTag) {
          return { ...(attrs as Partial<NodeDisplayData>), hidden: true }
        }
      }

      if (focusVisibleSet && !focusVisibleSet.has(node)) {
        return { ...(attrs as Partial<NodeDisplayData>), hidden: true }
      }

      if (searchLower && label) {
        const matches = label.toLowerCase().includes(searchLower)
        if (matches) {
          return {
            ...(attrs as Partial<NodeDisplayData>),
            highlighted: true,
            forceLabel: true,
            zIndex: 1
          }
        }
      }

      const activeHover = hoverTargetRef.current
      const fade = fadeRef.current

      if (!activeHover || fade === 0) return attrs as Partial<NodeDisplayData>

      const isHovered = node === activeHover
      const isNeighbor =
        graph.hasNode(activeHover) && graph.hasNode(node) && graph.areNeighbors(node, activeHover)

      if (isHovered) {
        return {
          ...(attrs as Partial<NodeDisplayData>),
          highlighted: true,
          forceLabel: true,
          zIndex: 1
        }
      }
      if (isNeighbor) {
        return attrs as Partial<NodeDisplayData>
      }

      const originalColor = (attrs.color as string) || '#999'
      return {
        ...(attrs as Partial<NodeDisplayData>),
        label: fade > 0.5 ? '' : (attrs.label as string),
        color: lerpColor(originalColor, dimmedColor, fade),
        zIndex: 0
      }
    },
    [graph, filterState, focusVisibleSet, searchLower, dimmedColor]
  )

  const edgeReducer = useCallback(
    (edge: string, attrs: Record<string, unknown>): Partial<EdgeDisplayData> => {
      if (!graph.hasEdge(edge)) return attrs as Partial<EdgeDisplayData>

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
        return { ...(attrs as Partial<EdgeDisplayData>), color: softEdgeColor, size: 1 }
      }

      const connected = source === activeHover || target === activeHover
      if (connected) {
        const targetSize = ((attrs.size as number) ?? 1) + 2
        return {
          ...(attrs as Partial<EdgeDisplayData>),
          color: softEdgeColor,
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
      labelRenderedSizeThreshold: graphSettings.showLabels ? 6 : Infinity,
      labelColor: { color: labelColor },
      labelSize: 12,
      defaultEdgeType: 'line' as const,
      renderEdgeLabels: false,
      minEdgeThickness: 0.5
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), [])

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
        />
        <GraphEvents
          onHoverNode={setHoveredNode}
          onTooltipMove={setTooltipPos}
          onFocusNode={onFocusNode}
          onContextMenu={setContextMenu}
          onNodeGrab={handleNodeGrab}
          onNodeDrag={handleNodeDrag}
          onNodeRelease={handleNodeRelease}
        />
      </SigmaContainer>
      {hoveredNode && tooltipPos && !contextMenu && (
        <GraphTooltip nodeId={hoveredNode} graph={graph} x={tooltipPos.x} y={tooltipPos.y} />
      )}
      {contextMenu && (
        <ContextMenuWithTabAction
          menu={contextMenu}
          graph={graph}
          onFocusNode={onFocusNode}
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
  themeKey: string | undefined
): { graph: Graph; revision: number } {
  const [graph] = useState(() => buildGraphologyGraph(data, options))
  const [revision, setRevision] = useState(0)
  const appliedRef = useRef({ data, options, themeKey })

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
    if (syncGraphologyGraph(graph, data, options).changed) {
      setRevision((current) => current + 1)
    }
  }, [graph, data, options, themeKey])
  /* eslint-enable react-you-might-not-need-an-effect/no-adjust-state-on-prop-change,
     react-you-might-not-need-an-effect/no-event-handler,
     react-you-might-not-need-an-effect/no-chain-state-updates */

  return { graph, revision }
}

function ContextMenuWithTabAction({
  menu,
  graph,
  onFocusNode,
  onClose
}: {
  menu: ContextMenuState
  graph: ReturnType<typeof buildGraphologyGraph>
  onFocusNode: (nodeId: string) => void
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

  return (
    <GraphContextMenu
      menu={menu}
      graph={graph}
      onFocusNode={onFocusNode}
      onOpenInTab={handleOpenInTab}
      onCreateNote={(...args) => void handleCreateNote(...args)}
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
      sigma.refresh()
      return
    }

    const startTime = performance.now()
    const duration = hoveredNode ? HOVER_FADE_IN_MS : HOVER_FADE_OUT_MS

    const tick = (now: number): void => {
      const t = Math.min((now - startTime) / duration, 1)
      fadeRef.current = startFade + (goal - startFade) * easeOutQuad(t)
      sigma.refresh()

      if (t < 1) {
        animRef.current = requestAnimationFrame(tick)
      } else {
        animRef.current = null
        if (!hoveredNode) {
          hoverTargetRef.current = null
          sigma.refresh()
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
    sigma.setSetting('labelRenderedSizeThreshold', showLabels ? 6 : Infinity)
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
  physicsHandleRef
}: {
  layout: GraphSettings['layout']
  animate: boolean
  graph: Graph
  revision: number
  physicsHandleRef: React.MutableRefObject<PhysicsHandle | null>
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
    <LivePhysics graph={graph} handleRef={physicsHandleRef} revision={revision} />
  ) : (
    <SettledPhysics graph={graph} revision={revision} />
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
