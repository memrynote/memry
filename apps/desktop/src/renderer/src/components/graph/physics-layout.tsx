import { useEffect, useRef } from 'react'
import { useSigma } from '@react-sigma/core'
import type Graph from 'graphology'
import { GraphPhysics, type GraphPhysicsOptions } from '@/lib/graph-physics'

/** Upper bound on the synchronous pre-settle, so a huge vault cannot lock the frame forever. */
const SETTLE_TICK_LIMIT = 400

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
  revision = 0,
  options
}: {
  graph: Graph
  handleRef: React.MutableRefObject<PhysicsHandle | null>
  /** Bumped whenever the graph was patched in place; never remounts the simulation. */
  revision?: number
  options?: GraphPhysicsOptions
}): null {
  const sigma = useSigma()
  const physicsRef = useRef<GraphPhysics | null>(null)
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    physicsRef.current = physics
    let frame: number | null = null

    const step = (): void => {
      physics.tick()
      // SigmaContainer recreates Sigma when `graph` changes and React may hand us
      // the old, killed instance; refreshing that one throws. Same guard as
      // SigmaSettingsSync.
      if (sigma.getGraph() === graph) sigma.refresh()
      frame = physics.isSettled ? null : requestAnimationFrame(step)
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
      }
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
  revision = 0,
  options
}: {
  graph: Graph
  /** Bumped whenever the graph was patched in place; never remounts the simulation. */
  revision?: number
  options?: GraphPhysicsOptions
}): null {
  const sigma = useSigma()
  const physicsRef = useRef<GraphPhysics | null>(null)

  useEffect(() => {
    const physics = new GraphPhysics(graph, options)
    physicsRef.current = physics
    settle(physics)
    if (sigma.getGraph() === graph) sigma.refresh()

    return () => {
      physicsRef.current = null
      physics.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, sigma])

  // Structural change on a patched graph: relax from where the nodes already sit
  // rather than re-deriving the whole arrangement from a cold start.
  useEffect(() => {
    const physics = physicsRef.current
    if (!physics?.sync()) return
    physics.reheat()
    settle(physics)
    if (sigma.getGraph() === graph) sigma.refresh()
  }, [revision, graph, sigma])

  return null
}

function settle(physics: GraphPhysics): void {
  for (let i = 0; i < SETTLE_TICK_LIMIT && !physics.isSettled; i++) {
    physics.tick()
  }
}
