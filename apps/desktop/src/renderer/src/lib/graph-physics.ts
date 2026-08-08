import type Graph from 'graphology'

interface PhysicsNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
  radius: number
  degree: number
}

interface PhysicsLink {
  source: PhysicsNode
  target: PhysicsNode
  /** How hard this link pulls, damped by the busier of its two endpoints. */
  strength: number
  /** Share of the correction applied to the source, so hubs move less than leaves. */
  bias: number
}

export interface GraphPhysicsOptions {
  linkDistance?: number
  chargeStrength?: number
  centeringStrength?: number
  alphaDecay?: number
  velocityDecay?: number
  collidePadding?: number
}

const DEFAULTS: Required<GraphPhysicsOptions> = {
  linkDistance: 45,
  chargeStrength: -220,
  centeringStrength: 0.045,
  // ~300 ticks from alpha 1 down to alphaMin, matching d3-force's feel.
  alphaDecay: 0.0228,
  velocityDecay: 0.38,
  collidePadding: 3
}

const ALPHA_MIN = 0.001

/** Energy injected when the graph is nudged back to life (filters, focus, reset). */
export const REHEAT_ALPHA = 0.35

/** Alpha the simulation is held at while a node is being dragged, so neighbours keep reacting. */
const DRAG_ALPHA_TARGET = 0.3

/**
 * Repulsion falls off as 1/d², so past a few link-lengths it is noise. Ignoring
 * those pairs is what keeps the tick O(n) instead of O(n²) on a large vault.
 */
const REPULSION_CUTOFF_FACTOR = 6

/** Collision passes per tick — more is stabler, but each one costs a full neighbour sweep. */
const COLLIDE_ITERATIONS = 1

/**
 * A continuously-running force simulation bound to a graphology graph.
 *
 * Unlike a one-shot layout, this never "finishes" on its own terms: it cools
 * toward rest, can be reheated, and holds a dragged node fixed while the rest of
 * the graph reacts to it. The caller owns the clock — call `tick()` once per
 * animation frame and render.
 *
 * Deliberately dependency-free: the desktop lockfile is pinned and adding a
 * force library re-resolves shared transitive deps across the whole workspace.
 */
export class GraphPhysics {
  private readonly graph: Graph
  private readonly settings: Required<GraphPhysicsOptions>
  private readonly nodes: PhysicsNode[] = []
  private readonly nodesById = new Map<string, PhysicsNode>()
  private readonly links: PhysicsLink[] = []
  private readonly cutoff: number
  private alphaValue = 1
  private alphaTarget = 0
  private destroyed = false

  constructor(graph: Graph, options: GraphPhysicsOptions = {}) {
    this.graph = graph
    this.settings = { ...DEFAULTS, ...options }
    this.cutoff = this.settings.linkDistance * REPULSION_CUTOFF_FACTOR

    graph.forEachNode((id, attrs) => {
      const node: PhysicsNode = {
        id,
        x: (attrs.x as number) ?? 0,
        y: (attrs.y as number) ?? 0,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        radius: ((attrs.size as number) ?? 4) * 1.2 + this.settings.collidePadding,
        degree: 0
      }
      this.nodes.push(node)
      this.nodesById.set(id, node)
    })

    graph.forEachEdge((edge) => {
      const [sourceId, targetId] = graph.extremities(edge)
      // Self-loops collapse to a zero-length spring and blow the solver up.
      if (sourceId === targetId) return
      const source = this.nodesById.get(sourceId)
      const target = this.nodesById.get(targetId)
      if (!source || !target) return
      source.degree++
      target.degree++
      this.links.push({ source, target, strength: 0, bias: 0 })
    })

    for (const link of this.links) {
      const total = link.source.degree + link.target.degree
      link.strength = 1 / Math.min(link.source.degree, link.target.degree)
      link.bias = total === 0 ? 0.5 : link.source.degree / total
    }
  }

  get alpha(): number {
    return this.alphaValue
  }

  get isSettled(): boolean {
    if (this.destroyed || this.nodes.length === 0) return true
    return this.alphaValue < ALPHA_MIN
  }

  /** Advance one step and publish the new positions to the graph. */
  tick(): void {
    if (this.destroyed || this.nodes.length === 0) return

    this.alphaValue += (this.alphaTarget - this.alphaValue) * this.settings.alphaDecay

    this.applyLinks()
    this.applyRepulsion()
    this.applyCentering()
    this.integrate()
    for (let i = 0; i < COLLIDE_ITERATIONS; i++) this.applyCollision()

    this.syncPositions()
  }

  reheat(alpha: number = REHEAT_ALPHA): void {
    if (this.destroyed) return
    if (this.alphaValue < alpha) this.alphaValue = alpha
  }

  /** Fix a node at its current position and keep the simulation warm while it is held. */
  grab(nodeId: string): void {
    const node = this.nodesById.get(nodeId)
    if (!node || this.destroyed) return
    node.fx = node.x
    node.fy = node.y
    this.alphaTarget = DRAG_ALPHA_TARGET
    this.reheat(DRAG_ALPHA_TARGET)
  }

  dragTo(nodeId: string, x: number, y: number): void {
    const node = this.nodesById.get(nodeId)
    if (!node || this.destroyed) return
    node.fx = x
    node.fy = y
  }

  /** Release a held node and let it relax back into the layout. */
  release(nodeId: string): void {
    const node = this.nodesById.get(nodeId)
    if (!node || this.destroyed) return
    node.fx = null
    node.fy = null
    this.alphaTarget = 0
  }

  destroy(): void {
    this.destroyed = true
    this.nodes.length = 0
    this.links.length = 0
    this.nodesById.clear()
  }

  /** Springs pulling each linked pair toward `linkDistance`. */
  private applyLinks(): void {
    const { linkDistance } = this.settings
    for (const link of this.links) {
      const { source, target } = link
      const dx = target.x + target.vx - source.x - source.vx
      const dy = target.y + target.vy - source.y - source.vy
      const distance = Math.hypot(dx, dy) || 1e-6
      const push = ((distance - linkDistance) / distance) * this.alphaValue * link.strength
      const fx = dx * push
      const fy = dy * push

      target.vx -= fx * link.bias
      target.vy -= fy * link.bias
      source.vx += fx * (1 - link.bias)
      source.vy += fy * (1 - link.bias)
    }
  }

  /**
   * Inverse-square repulsion between nearby nodes. A uniform grid sized to the
   * cutoff keeps each node comparing against a handful of neighbours.
   */
  private applyRepulsion(): void {
    const { chargeStrength } = this.settings
    const cutoff = this.cutoff
    const cutoffSquared = cutoff * cutoff
    const grid = new Map<string, PhysicsNode[]>()

    for (const node of this.nodes) {
      const key = `${Math.floor(node.x / cutoff)},${Math.floor(node.y / cutoff)}`
      const cell = grid.get(key)
      if (cell) cell.push(node)
      else grid.set(key, [node])
    }

    for (const node of this.nodes) {
      const cellX = Math.floor(node.x / cutoff)
      const cellY = Math.floor(node.y / cutoff)

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cell = grid.get(`${cellX + ox},${cellY + oy}`)
          if (!cell) continue

          for (const other of cell) {
            if (other === node) continue
            let dx = other.x - node.x
            let dy = other.y - node.y
            let distanceSquared = dx * dx + dy * dy
            if (distanceSquared > cutoffSquared) continue

            if (distanceSquared === 0) {
              // Deterministic nudge so coincident nodes still separate.
              dx = 1e-3
              dy = 1e-3
              distanceSquared = dx * dx + dy * dy
            }

            const push = (chargeStrength * this.alphaValue) / distanceSquared
            node.vx += dx * push
            node.vy += dy * push
          }
        }
      }
    }
  }

  /** Weak pull toward the origin so the graph stays a graph and not a diaspora. */
  private applyCentering(): void {
    const pull = this.settings.centeringStrength * this.alphaValue
    for (const node of this.nodes) {
      node.vx -= node.x * pull
      node.vy -= node.y * pull
    }
  }

  private integrate(): void {
    const friction = 1 - this.settings.velocityDecay
    for (const node of this.nodes) {
      if (node.fx !== null) {
        node.x = node.fx
        node.vx = 0
      } else {
        node.vx *= friction
        node.x += node.vx
      }

      if (node.fy !== null) {
        node.y = node.fy
        node.vy = 0
      } else {
        node.vy *= friction
        node.y += node.vy
      }
    }
  }

  /** Position-based separation so node discs never overlap — the "cell" packing. */
  private applyCollision(): void {
    const grid = new Map<string, PhysicsNode[]>()
    let maxRadius = 0
    for (const node of this.nodes) maxRadius = Math.max(maxRadius, node.radius)
    const cellSize = Math.max(maxRadius * 2, 1)

    for (const node of this.nodes) {
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`
      const cell = grid.get(key)
      if (cell) cell.push(node)
      else grid.set(key, [node])
    }

    for (const node of this.nodes) {
      const cellX = Math.floor(node.x / cellSize)
      const cellY = Math.floor(node.y / cellSize)

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cell = grid.get(`${cellX + ox},${cellY + oy}`)
          if (!cell) continue

          for (const other of cell) {
            if (other === node || other.id <= node.id) continue
            const minimum = node.radius + other.radius
            let dx = other.x - node.x
            let dy = other.y - node.y
            let distance = Math.hypot(dx, dy)
            if (distance >= minimum) continue

            if (distance === 0) {
              dx = 1e-3
              dy = 1e-3
              distance = Math.hypot(dx, dy)
            }

            const overlap = ((minimum - distance) / distance) * 0.5
            const shiftX = dx * overlap
            const shiftY = dy * overlap

            if (other.fx === null) other.x += shiftX
            if (other.fy === null) other.y += shiftY
            if (node.fx === null) node.x -= shiftX
            if (node.fy === null) node.y -= shiftY
          }
        }
      }
    }
  }

  /**
   * Publish this tick's positions onto the graph, without announcing them.
   *
   * `setNodeAttribute` emits a `nodeAttributesUpdated` per axis — two graphology
   * events per node per frame. Sigma is the only subscriber (`bindGraphHandlers`),
   * and all its handler does for a moved node is re-run the node reducer and
   * schedule a partial refresh. Neither is needed here: the caller refreshes
   * sigma itself immediately after every tick, and sigma's indexation pass reads
   * x/y straight back off the graph for every node, so the frame is painted from
   * these exact values either way. Writing into the node's live attribute object
   * skips the announcement and keeps the value identical to the bit.
   *
   * Only nodes this simulation owns are touched, so anything added to the graph
   * after construction keeps whatever position put it there.
   */
  private syncPositions(): void {
    for (const node of this.nodes) {
      if (!this.graph.hasNode(node.id)) continue
      const attributes = this.graph.getNodeAttributes(node.id)
      attributes.x = node.x
      attributes.y = node.y
    }
  }
}
