import { useEffect, useRef } from 'react'
import { useSigma } from '@react-sigma/core'
import type Graph from 'graphology'
import { GraphPhysics, type GraphPhysicsOptions, type NodePosition } from '@/lib/graph-physics'
import { refreshSigmaIfMeasurable } from '@/lib/sigma-refresh'

/** Upper bound on the synchronous pre-settle, so a huge vault cannot lock the frame forever. */
const SETTLE_TICK_LIMIT = 400

/**
 * A physics frame only moves nodes, so this repaints the motion without asking
 * sigma to re-derive what everything looks like.
 *
 * An empty partial graph skips the node and edge reducers — the O(N+E) pass that
 * spreads every attribute map into a fresh object and walks `areNeighbors` /
 * `extremities` — while still running indexation, which re-reads x/y off the
 * graph for every node and re-feeds both the node and the edge programs. Nothing
 * a reducer produces (colour, label, size, visibility, highlight, zIndex) is
 * derived from position, and sigma re-runs them itself on every input that is:
 * `setSetting` with a new reducer identity (filters, focus set, search, theme
 * colours), the hover fade's own full refresh, and graphology's
 * added/dropped/attributes-updated events.
 */
const REPAINT_MOVEMENT_ONLY = { partialGraph: {} }

export interface PhysicsHandle {
  grab: (nodeId: string) => void
  drag: (nodeId: string, x: number, y: number) => void
  release: (nodeId: string) => void
  /** End a drag with the node held where it was dropped. */
  pin: (nodeId: string) => void
  unpin: (nodeId: string) => void
  isPinned: (nodeId: string) => boolean
}

/** Receives every position once the layout comes to rest or a pin changes. */
export type LayoutChangeHandler = (positions: Record<string, NodePosition>) => void

/** Latest callback without restarting the simulation when its identity changes. */
function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/**
 * Live force simulation: one tick per animation frame, parked once the graph
 * comes to rest and woken again whenever a node is grabbed.
 */
export function LivePhysics({
  graph,
  handleRef,
  revision = 0,
  options,
  onLayoutChange
}: {
  graph: Graph
  handleRef: React.MutableRefObject<PhysicsHandle | null>
  /** Bumped whenever the graph was patched in place; never remounts the simulation. */
  revision?: number
  options?: GraphPhysicsOptions
  onLayoutChange?: LayoutChangeHandler
}): null {
  const sigma = useSigma()
  const physicsRef = useRef<GraphPhysics | null>(null)
  const wakeRef = useRef<() => void>(() => {})
  const onLayoutChangeRef = useLatest(onLayoutChange)

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    physicsRef.current = physics
    let frame: number | null = null

    const step = (): void => {
      physics.tick()
      // SigmaContainer recreates Sigma when `graph` changes and React may hand us
      // the old, killed instance; refreshing that one throws. Same guard as
      // SigmaSettingsSync.
      if (sigma.getGraph() === graph) refreshSigmaIfMeasurable(sigma, REPAINT_MOVEMENT_ONLY)
      if (physics.isSettled) {
        frame = null
        onLayoutChangeRef.current?.(physics.snapshot())
      } else {
        frame = requestAnimationFrame(step)
      }
    }

    const wake = (): void => {
      if (frame === null) frame = requestAnimationFrame(step)
    }
    wakeRef.current = wake

    handleRef.current = {
      grab: (nodeId) => {
        physics.grab(nodeId)
        wake()
      },
      drag: (nodeId, x, y) => {
        physics.dragTo(nodeId, x, y)
        wake()
      },
      release: (nodeId) => {
        physics.release(nodeId)
        wake()
      },
      // Pin changes are saved right away, not at rest: the graph may be closed
      // before the simulation settles.
      pin: (nodeId) => {
        physics.pin(nodeId)
        onLayoutChangeRef.current?.(physics.snapshot())
        wake()
      },
      unpin: (nodeId) => {
        physics.unpin(nodeId)
        onLayoutChangeRef.current?.(physics.snapshot())
        wake()
      },
      isPinned: (nodeId) => physics.isPinned(nodeId)
    }

    frame = requestAnimationFrame(step)

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      handleRef.current = null
      wakeRef.current = () => {}
      physicsRef.current = null
      physics.destroy()
    }
    // `options` is a static per-call-site literal; re-running on identity would
    // restart the simulation every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, sigma, handleRef])

  // A save patched the graph while it stayed mounted. Fold the new nodes and
  // edges into the running simulation and give it just enough energy to absorb
  // them, instead of throwing the layout away and starting over at alpha 1.
  useEffect(() => {
    const physics = physicsRef.current
    if (!physics?.sync()) return
    physics.reheat()
    wakeRef.current()
  }, [revision])

  return null
}

/** Same forces, run to rest in one pass — the static arrangement when live motion is off. */
export function SettledPhysics({
  graph,
  handleRef,
  revision = 0,
  options,
  onLayoutChange
}: {
  graph: Graph
  /** Dragging is a live-motion feature; here the handle only reads and clears pins. */
  handleRef?: React.MutableRefObject<PhysicsHandle | null>
  /** Bumped whenever the graph was patched in place; never remounts the simulation. */
  revision?: number
  options?: GraphPhysicsOptions
  onLayoutChange?: LayoutChangeHandler
}): null {
  const sigma = useSigma()
  const physicsRef = useRef<GraphPhysics | null>(null)
  const onLayoutChangeRef = useLatest(onLayoutChange)

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    physicsRef.current = physics
    const settleAndPaint = (): void => {
      settle(physics)
      if (sigma.getGraph() === graph) refreshSigmaIfMeasurable(sigma)
      onLayoutChangeRef.current?.(physics.snapshot())
    }
    settleAndPaint()

    if (handleRef) {
      handleRef.current = {
        grab: () => {},
        drag: () => {},
        release: () => {},
        pin: () => {},
        unpin: (nodeId) => {
          if (!physics.isPinned(nodeId)) return
          physics.unpin(nodeId)
          settleAndPaint()
        },
        isPinned: (nodeId) => physics.isPinned(nodeId)
      }
    }

    return () => {
      if (handleRef) handleRef.current = null
      physicsRef.current = null
      physics.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, sigma, handleRef])

  // Structural change on a patched graph: relax from where the nodes already sit
  // rather than re-deriving the whole arrangement from a cold start.
  useEffect(() => {
    const physics = physicsRef.current
    if (!physics?.sync()) return
    physics.reheat()
    settle(physics)
    if (sigma.getGraph() === graph) refreshSigmaIfMeasurable(sigma)
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-ref-to-parent -- the ref holds the latest save callback (useLatest), not a DOM node; the settled positions only exist after this effect runs
    onLayoutChangeRef.current?.(physics.snapshot())
  }, [revision, graph, sigma, onLayoutChangeRef])

  return null
}

function settle(physics: GraphPhysics): void {
  for (let i = 0; i < SETTLE_TICK_LIMIT && !physics.isSettled; i++) {
    physics.tick()
  }
}
