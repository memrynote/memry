import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { SigmaContainer, useSigma } from '@react-sigma/core'
import { useTheme } from 'next-themes'
import '@react-sigma/core/lib/style.css'
import { X, Maximize2 } from '@/lib/icons'
import Graph from 'graphology'
import type { NodeDisplayData, EdgeDisplayData } from 'sigma/types'
import type { GraphDataResponse } from '@memry/contracts/graph-api'
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

  const { graph, layoutRevision } = useLiveLocalGraph(data, resolvedTheme)

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

  const initialSigmaSettings = useMemo(
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
    // Frozen on purpose: a new settings object makes SigmaContainer rebuild the
    // renderer. Reducers that change afterwards are pushed by LocalSigmaSettingsSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
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

  if (isLoading || !data) {
    return (
      <div className="relative h-[250px] rounded-md border border-border bg-muted/30">
        <div className="flex h-full items-center justify-center">
          <span className="text-xs text-muted-foreground">{t('local-panel.loading')}</span>
        </div>
        <PanelHeader onClose={onClose} />
      </div>
    )
  }

  if (data.nodes.length === 0) {
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

      <SigmaContainer graph={graph} settings={initialSigmaSettings} className="h-full w-full">
        <LocalSigmaSettingsSync nodeReducer={nodeReducer} edgeReducer={edgeReducer} />
        <LocalHoverFadeAnimator
          hoveredNode={hoveredNode}
          fadeRef={fadeRef}
          hoverTargetRef={hoverTargetRef}
        />
        {/* Remounting the simulation is how nodes a refetch added get placed: the
            graph instance outlives them now, so the effect keyed on it never re-runs. */}
        <LivePhysics
          key={layoutRevision}
          graph={graph}
          handleRef={physicsHandleRef}
          options={LOCAL_PHYSICS}
        />
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

/**
 * One graphology instance for the panel's lifetime, refilled in place as data arrives.
 *
 * `SigmaContainer` kills and rebuilds Sigma — and with it the WebGL context — whenever
 * the `graph` or `settings` prop changes identity, and the note page invalidates
 * `graphKeys.local(noteId)` on every 1s save debounce. Building a new graph per refetch
 * therefore burned a WebGL context per keystroke pause; browsers cap the live ones and
 * silently drop the oldest, which blanks graphs elsewhere in the app.
 *
 * `layoutRevision` counts the refills that changed the node or edge set, so the force
 * simulation is restarted only when it has something new to place.
 */
function useLiveLocalGraph(
  data: GraphDataResponse | undefined,
  themeKey: string | undefined
): { graph: Graph; layoutRevision: number } {
  const [graph] = useState(() => new Graph({ multi: true, type: 'undirected' }))
  const appliedRef = useRef<{ data: GraphDataResponse; themeKey: string | undefined } | null>(null)
  const [layoutRevision, setLayoutRevision] = useState(0)

  useEffect(() => {
    if (!data) return
    const applied = appliedRef.current
    // `themeKey` takes part because a theme flip re-resolves the CSS colour
    // variables every node and edge attribute was built from.
    if (applied && applied.data === data && applied.themeKey === themeKey) return
    appliedRef.current = { data, themeKey }
    /* eslint-disable react-you-might-not-need-an-effect/no-event-handler,
       react-you-might-not-need-an-effect/no-chain-state-updates,
       react-you-might-not-need-an-effect/no-adjust-state-on-prop-change -- genuine external sync: the
       graphology instance Sigma is bound to is mutated here, and the counter only records that
       its node or edge set moved so the simulation can be rebuilt. Refilling during render
       would fire graphology's change events mid-render. */
    if (refillGraph(graph, buildGraphologyGraph(data))) {
      setLayoutRevision((current) => current + 1)
    }
    /* eslint-enable react-you-might-not-need-an-effect/no-event-handler,
       react-you-might-not-need-an-effect/no-chain-state-updates,
       react-you-might-not-need-an-effect/no-adjust-state-on-prop-change */
  }, [graph, data, themeKey])

  return { graph, layoutRevision }
}

/**
 * Make `graph` hold exactly what `next` holds, without replacing the instance.
 *
 * Attributes are copied from a freshly built graph rather than recomputed here, so this
 * can never drift from `buildGraphologyGraph` (tag nodes, degree-scaled sizes). Nodes
 * that survive keep the position the simulation settled them at — the arrangement the
 * user is looking at. Returns true when the node or edge set changed.
 */
function refillGraph(graph: Graph, next: Graph): boolean {
  // Measured before the refill, and only over the node and edge sets: an attribute-only
  // refetch — a word count ticking up as the user types — must not disturb the layout.
  const structureChanged =
    next.someNode((node) => !graph.hasNode(node)) ||
    graph.someNode((node) => !next.hasNode(node)) ||
    next.someEdge((edge) => !graph.hasEdge(edge)) ||
    graph.someEdge((edge) => !next.hasEdge(edge))

  for (const node of graph.nodes()) {
    if (!next.hasNode(node)) graph.dropNode(node)
  }

  for (const edge of graph.edges()) {
    if (!next.hasEdge(edge)) graph.dropEdge(edge)
  }

  next.forEachNode((node, attributes) => {
    if (!graph.hasNode(node)) {
      graph.addNode(node, attributes)
      return
    }
    graph.replaceNodeAttributes(node, {
      ...attributes,
      x: graph.getNodeAttribute(node, 'x'),
      y: graph.getNodeAttribute(node, 'y')
    })
  })

  next.forEachEdge((edge, attributes, source, target) => {
    if (graph.hasEdge(edge)) {
      graph.replaceEdgeAttributes(edge, attributes)
      return
    }
    graph.addEdgeWithKey(edge, source, target, attributes)
  })

  return structureChanged
}

/**
 * Pushes the current reducers onto the live Sigma. `settings` is frozen at first render
 * because handing SigmaContainer a new object rebuilds the renderer, so reducers that
 * close over changed props (a different centre note) have to be applied imperatively.
 */
function LocalSigmaSettingsSync({
  nodeReducer,
  edgeReducer
}: {
  nodeReducer: (node: string, attrs: Record<string, unknown>) => Partial<NodeDisplayData>
  edgeReducer: (edge: string, attrs: Record<string, unknown>) => Partial<EdgeDisplayData>
}): null {
  const sigma = useSigma()

  useEffect(() => {
    sigma.setSetting('nodeReducer', nodeReducer)
  }, [sigma, nodeReducer])

  useEffect(() => {
    sigma.setSetting('edgeReducer', edgeReducer)
  }, [sigma, edgeReducer])

  return null
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
