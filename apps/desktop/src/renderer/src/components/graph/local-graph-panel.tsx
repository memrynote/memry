import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { SigmaContainer, useSigma } from '@react-sigma/core'
import { useTheme } from 'next-themes'
import '@react-sigma/core/lib/style.css'
import { X, Maximize2 } from '@/lib/icons'
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types'
import { Button } from '@/components/ui/button'
import { useLocalGraphData } from '@/hooks/use-graph-data'
import { buildGraphologyGraph } from '@/lib/graph-builder'
import type { GraphPhysicsOptions } from '@/lib/graph-physics'
import { useT } from '@memry/i18n/renderer'
import { GraphEvents } from './graph-events'
import { GraphTooltip } from './graph-tooltip'
import { LivePhysics, type PhysicsHandle } from './physics-layout'

const CENTER_HIGHLIGHT_COLOR = '#f59e0b'
const HOVER_FADE_IN_MS = 250
const HOVER_FADE_OUT_MS = 180

/** Tighter than the full graph — this panel is only 250px tall. */
const LOCAL_PHYSICS: GraphPhysicsOptions = {
  linkDistance: 32,
  chargeStrength: -140
}

function resolveGraphVar(varName: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t)
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
  const { t } = useT('graph')
  const { resolvedTheme } = useTheme()
  const { data, isLoading } = useLocalGraphData(noteId)

  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const fadeRef = useRef(0)
  const hoverTargetRef = useRef<string | null>(null)
  const physicsHandleRef = useRef<PhysicsHandle | null>(null)

  const dimmedColor = useMemo(() => resolveGraphVar('--graph-dimmed-node', '#e4e4de'), [])

  const softEdgeColor = useMemo(() => resolveGraphVar('--graph-edge-soft', '#d5d3cd'), [])

  const labelColor = useMemo(() => resolveGraphVar('--graph-label-color', '#1a1a1a'), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => (data ? buildGraphologyGraph(data) : null), [data, resolvedTheme])

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

      const activeHover = hoverTargetRef.current
      const fade = fadeRef.current
      if (!activeHover || fade === 0) return baseAttrs

      const isHovered = node === activeHover
      const isNeighbor = graph?.hasNode(activeHover) && graph.areNeighbors(node, activeHover)

      if (isHovered) {
        return { ...baseAttrs, highlighted: true, zIndex: 1 }
      }
      if (isNeighbor || node === noteId) {
        return baseAttrs
      }
      return { ...baseAttrs, label: '', color: dimmedColor, zIndex: 0 }
    },
    [graph, noteId, dimmedColor]
  )

  const edgeReducer = useCallback(
    (edge: string, attrs: Record<string, unknown>): Partial<EdgeDisplayData> => {
      if (!graph?.hasEdge(edge)) return attrs as Partial<EdgeDisplayData>

      const activeHover = hoverTargetRef.current
      const fade = fadeRef.current

      if (!activeHover || fade === 0 || !graph.hasNode(activeHover)) {
        return { ...(attrs as Partial<EdgeDisplayData>), color: softEdgeColor, size: 1 }
      }

      const [source, target] = graph.extremities(edge)
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
    [graph, softEdgeColor]
  )

  const sigmaSettings = useMemo(
    () => ({
      nodeReducer,
      edgeReducer,
      labelRenderedSizeThreshold: 8,
      labelColor: { color: labelColor },
      labelSize: 11,
      defaultEdgeType: 'line' as const,
      renderEdgeLabels: false,
      minEdgeThickness: 0.5
    }),
    [nodeReducer, edgeReducer, labelColor]
  )

  const handleFocusNode = useCallback(() => {}, [])

  const handleNodeGrab = useCallback((nodeId: string) => {
    physicsHandleRef.current?.grab(nodeId)
  }, [])

  const handleNodeDrag = useCallback((nodeId: string, x: number, y: number) => {
    physicsHandleRef.current?.drag(nodeId, x, y)
  }, [])

  const handleNodeRelease = useCallback((nodeId: string) => {
    physicsHandleRef.current?.release(nodeId)
  }, [])

  if (isLoading || !graph) {
    return (
      <div className="relative h-[250px] rounded-md border border-border bg-muted/30">
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-muted-foreground">{t('local-panel.loading')}</span>
        </div>
        <PanelHeader onClose={onClose} />
      </div>
    )
  }

  if (graph.order === 0) {
    return (
      <div className="relative h-[250px] rounded-md border border-border bg-muted/30">
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-muted-foreground">{t('local-panel.empty')}</span>
        </div>
        <PanelHeader onClose={onClose} />
      </div>
    )
  }

  return (
    <div className="relative h-[250px] rounded-md border border-border bg-muted/30 overflow-hidden">
      <PanelHeader onClose={onClose} onOpenFullGraph={onOpenFullGraph} />

      <SigmaContainer graph={graph} settings={sigmaSettings} className="h-full w-full">
        <LocalHoverFadeAnimator
          hoveredNode={hoveredNode}
          fadeRef={fadeRef}
          hoverTargetRef={hoverTargetRef}
        />
        <LivePhysics graph={graph} handleRef={physicsHandleRef} options={LOCAL_PHYSICS} />
        <GraphEvents
          onHoverNode={setHoveredNode}
          onTooltipMove={setTooltipPos}
          onFocusNode={handleFocusNode}
          onNodeGrab={handleNodeGrab}
          onNodeDrag={handleNodeDrag}
          onNodeRelease={handleNodeRelease}
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
  const { t } = useT('graph')

  return (
    <div className="absolute top-1.5 end-1.5 z-10 flex items-center gap-1">
      {onOpenFullGraph && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 bg-popover/80 backdrop-blur-sm hover:bg-popover"
          onClick={onOpenFullGraph}
          title={t('local-panel.open-full')}
        >
          <Maximize2 className="size-3" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 bg-popover/80 backdrop-blur-sm hover:bg-popover"
        onClick={onClose}
        title={t('local-panel.close')}
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}

function LocalHoverFadeAnimator({
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
