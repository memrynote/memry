import { useState, useCallback, useMemo } from 'react'
import { SigmaContainer } from '@react-sigma/core'
import { useWorkerLayoutForceAtlas2 } from '@react-sigma/layout-forceatlas2'
import '@react-sigma/core/lib/style.css'
import { X, Maximize2 } from 'lucide-react'
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types'
import { Button } from '@/components/ui/button'
import { useLocalGraphData } from '@/hooks/use-graph-data'
import { buildGraphologyGraph } from '@/lib/graph-builder'
import { GraphEvents } from './graph-events'
import { GraphTooltip } from './graph-tooltip'
import { useEffect, useRef } from 'react'

const CENTER_HIGHLIGHT_COLOR = '#f59e0b'

function resolveDimmedColor(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--graph-dimmed-node').trim() ||
    '#e4e4de'
  )
}

interface LocalGraphPanelProps {
  noteId: string
  onClose: () => void
  onOpenFullGraph?: () => void
}

export function LocalGraphPanel({
  noteId,
  onClose,
  onOpenFullGraph
}: LocalGraphPanelProps): React.JSX.Element {
  const { data, isLoading } = useLocalGraphData(noteId)

  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  const dimmedColor = useMemo(resolveDimmedColor, [])
  const graph = useMemo(() => (data ? buildGraphologyGraph(data) : null), [data])

  const nodeReducer = useCallback(
    (node: string, attrs: Record<string, unknown>): Partial<NodeDisplayData> => {
      const isCenter = node === noteId
      const baseAttrs = attrs as Partial<NodeDisplayData>

      if (isCenter) {
        return {
          ...baseAttrs,
          size: ((baseAttrs.size as number) ?? 6) * 1.6,
          color: CENTER_HIGHLIGHT_COLOR,
          highlighted: true,
          zIndex: 2,
          forceLabel: true
        }
      }

      if (!hoveredNode) return baseAttrs

      const isHovered = node === hoveredNode
      const isNeighbor = graph?.hasNode(hoveredNode) && graph.areNeighbors(node, hoveredNode)

      if (isHovered) {
        return { ...baseAttrs, highlighted: true, zIndex: 1 }
      }
      if (isNeighbor || node === noteId) {
        return baseAttrs
      }
      return { ...baseAttrs, label: '', color: dimmedColor, zIndex: 0 }
    },
    [hoveredNode, graph, noteId, dimmedColor]
  )

  const edgeReducer = useCallback(
    (edge: string, attrs: Record<string, unknown>): Partial<EdgeDisplayData> => {
      if (!hoveredNode || !graph?.hasNode(hoveredNode) || !graph.hasEdge(edge)) {
        return attrs as Partial<EdgeDisplayData>
      }

      const [source, target] = graph.extremities(edge)
      const connected = source === hoveredNode || target === hoveredNode
      if (!connected) {
        return { ...(attrs as Partial<EdgeDisplayData>), hidden: true }
      }
      return attrs as Partial<EdgeDisplayData>
    },
    [hoveredNode, graph]
  )

  const sigmaSettings = useMemo(
    () => ({
      nodeReducer,
      edgeReducer,
      labelRenderedSizeThreshold: 8,
      labelSize: 11,
      defaultEdgeType: 'line' as const,
      renderEdgeLabels: false
    }),
    [nodeReducer, edgeReducer]
  )

  const handleFocusNode = useCallback(() => {}, [])

  if (isLoading || !graph) {
    return (
      <div className="relative h-[250px] rounded-lg border border-border bg-muted/30">
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-muted-foreground">Loading graph...</span>
        </div>
        <PanelHeader onClose={onClose} />
      </div>
    )
  }

  if (graph.order === 0) {
    return (
      <div className="relative h-[250px] rounded-lg border border-border bg-muted/30">
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-muted-foreground">No connections found</span>
        </div>
        <PanelHeader onClose={onClose} />
      </div>
    )
  }

  return (
    <div className="relative h-[250px] rounded-lg border border-border bg-muted/30 overflow-hidden">
      <PanelHeader onClose={onClose} onOpenFullGraph={onOpenFullGraph} />

      <SigmaContainer graph={graph} settings={sigmaSettings} className="h-full w-full">
        <LocalForceLayout />
        <GraphEvents
          onHoverNode={setHoveredNode}
          onTooltipMove={setTooltipPos}
          onFocusNode={handleFocusNode}
        />
      </SigmaContainer>

      {hoveredNode && tooltipPos && (
        <GraphTooltip nodeId={hoveredNode} graph={graph} x={tooltipPos.x} y={tooltipPos.y} />
      )}
    </div>
  )
}

function PanelHeader({
  onClose,
  onOpenFullGraph
}: {
  onClose: () => void
  onOpenFullGraph?: () => void
}): React.JSX.Element {
  return (
    <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
      {onOpenFullGraph && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 bg-popover/80 backdrop-blur-sm hover:bg-popover"
          onClick={onOpenFullGraph}
          title="Open full graph"
        >
          <Maximize2 className="size-3" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 bg-popover/80 backdrop-blur-sm hover:bg-popover"
        onClick={onClose}
        title="Close graph"
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

function LocalForceLayout(): null {
  const { start, stop } = useWorkerLayoutForceAtlas2({
    settings: {
      gravity: 0.5,
      scalingRatio: 4,
      slowDown: 3,
      barnesHutOptimize: true
    }
  })

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    start()
    timerRef.current = setTimeout(stop, 4000)

    return () => {
      clearTimeout(timerRef.current)
      stop()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}
