import { useEffect } from 'react'
import { useSigma } from '@react-sigma/core'
import type Graph from 'graphology'
import { GraphPhysics, type GraphPhysicsOptions } from '@/lib/graph-physics'

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
}

/**
 * Live force simulation: one tick per animation frame, parked once the graph
 * comes to rest and woken again whenever a node is grabbed.
 */
export function LivePhysics({
  graph,
  handleRef,
  options
}: {
  graph: Graph
  handleRef: React.MutableRefObject<PhysicsHandle | null>
  options?: GraphPhysicsOptions
}): null {
  const sigma = useSigma()

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    let frame: number | null = null

    const step = (): void => {
      physics.tick()
      // SigmaContainer recreates Sigma when `graph` changes and React may hand us
      // the old, killed instance; refreshing that one throws. Same guard as
      // SigmaSettingsSync.
      if (sigma.getGraph() === graph) sigma.refresh(REPAINT_MOVEMENT_ONLY)
      frame = physics.isSettled ? null : requestAnimationFrame(step)
    }

    const wake = (): void => {
      if (frame === null) frame = requestAnimationFrame(step)
    }

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
      }
    }

    frame = requestAnimationFrame(step)

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      handleRef.current = null
      physics.destroy()
    }
    // `options` is a static per-call-site literal; re-running on identity would
    // restart the simulation every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, sigma, handleRef])

  return null
}

/** Same forces, run to rest in one pass — the static arrangement when live motion is off. */
export function SettledPhysics({
  graph,
  options
}: {
  graph: Graph
  options?: GraphPhysicsOptions
}): null {
  const sigma = useSigma()

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    for (let i = 0; i < SETTLE_TICK_LIMIT && !physics.isSettled; i++) {
      physics.tick()
    }
    physics.destroy()
    if (sigma.getGraph() === graph) sigma.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, sigma])

  return null
}
