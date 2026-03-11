import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { SigmaContainer } from '@react-sigma/core'
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2'
import '@react-sigma/core/lib/style.css'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types'
import { buildGraphologyGraph, computeFocusSet, type BuildGraphOptions } from '@/lib/graph-builder'
import type { GraphFilterState } from '@/hooks/use-graph-filters'
import type { GraphSettings } from '@memry/contracts/graph-api'
import { useTabActions } from '@/contexts/tabs'
import { useNoteMutations } from '@/hooks/use-notes-query'
import { GraphEvents } from './graph-events'
import { GraphTooltip } from './graph-tooltip'
import { GraphContextMenu, type ContextMenuState } from './graph-context-menu'

const ENTITY_TYPE_VISIBILITY: Record<string, keyof GraphFilterState> = {
  note: 'showNotes',
  journal: 'showJournals',
  task: 'showTasks',
  project: 'showProjects'
}

function resolveDimmedColor(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--graph-dimmed-node').trim() ||
    '#e4e4de'
  )
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
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const dimmedColor = useMemo(resolveDimmedColor, [])

  const graphBuildOptions: BuildGraphOptions = useMemo(
    () => ({ showTagEdges: graphSettings.showTagEdges, nodeSizing: graphSettings.nodeSizing }),
    [graphSettings.showTagEdges, graphSettings.nodeSizing]
  )

  const graph = useMemo(
    () => buildGraphologyGraph(data, graphBuildOptions),
    [data, graphBuildOptions]
  )

  const focusVisibleSet = useMemo(() => {
    if (!filterState.focusNodeId) return null
    return computeFocusSet(graph, filterState.focusNodeId, filterState.focusDepth)
  }, [graph, filterState.focusNodeId, filterState.focusDepth])

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

      if (!hoveredNode) return attrs as Partial<NodeDisplayData>

      const isHovered = node === hoveredNode
      const isNeighbor = graph.hasNode(hoveredNode) && graph.areNeighbors(node, hoveredNode)

      if (isHovered) {
        return {
          ...(attrs as Partial<NodeDisplayData>),
          highlighted: true,
          forceLabel: true,
          zIndex: 1
        }
      }
      if (isNeighbor) {
        return { ...(attrs as Partial<NodeDisplayData>), forceLabel: true }
      }
      return {
        ...(attrs as Partial<NodeDisplayData>),
        label: '',
        color: dimmedColor,
        zIndex: 0
      }
    },
    [hoveredNode, graph, filterState, focusVisibleSet, searchLower, dimmedColor]
  )

  const edgeReducer = useCallback(
    (edge: string, attrs: Record<string, unknown>): Partial<EdgeDisplayData> => {
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

      if (!hoveredNode || !graph.hasNode(hoveredNode)) {
        return attrs as Partial<EdgeDisplayData>
      }

      const connected = source === hoveredNode || target === hoveredNode
      if (!connected) {
        return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
      }

      return attrs as Partial<EdgeDisplayData>
    },
    [hoveredNode, graph, filterState, focusVisibleSet]
  )

  const sigmaSettings = useMemo(
    () => ({
      nodeReducer,
      edgeReducer,
      labelRenderedSizeThreshold: Infinity,
      labelSize: 12,
      defaultEdgeType: 'line' as const,
      renderEdgeLabels: graphSettings.showEdgeLabels
    }),
    [nodeReducer, edgeReducer, graphSettings.showEdgeLabels]
  )

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), [])

  return (
    <div className="relative h-full w-full">
      <SigmaContainer graph={graph} settings={sigmaSettings} className="h-full w-full">
        {graphSettings.layout === 'forceatlas2' && (
          <ForceAtlas2Layout
            repulsionStrength={graphSettings.repulsionStrength}
            linkDistance={graphSettings.linkDistance}
            animate={graphSettings.animateLayout}
          />
        )}
        <GraphEvents
          onHoverNode={setHoveredNode}
          onTooltipMove={setTooltipPos}
          onFocusNode={onFocusNode}
          onContextMenu={setContextMenu}
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
        title: (attrs.label as string) || 'Untitled',
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
        isPreview: true,
        isDeleted: false
      })
    },
    [graph, openTab]
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
      onCreateNote={handleCreateNote}
      onClose={onClose}
    />
  )
}

function ForceAtlas2Layout({
  repulsionStrength,
  linkDistance,
  animate
}: {
  repulsionStrength: number
  linkDistance: number
  animate: boolean
}): null {
  const gravity = Math.max(0.1, 1 - linkDistance / 200)
  const scalingRatio = 1 + (repulsionStrength / 100) * 9

  const { start, stop } = useWorkerLayoutForceAtlas2({
    settings: {
      gravity,
      scalingRatio,
      slowDown: 2,
      barnesHutOptimize: true
    }
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!animate) return
    start()
    timerRef.current = setTimeout(stop, 8000)

    return () => {
      clearTimeout(timerRef.current)
      stop()
    }
  }, [animate]) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
