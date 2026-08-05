/**
 * Pure planning for agent-authored canvas drawing.
 *
 * Turns the wire spec (contracts/canvas-draw) into Excalidraw element
 * skeletons plus a binding plan, and applies edits to an existing scene.
 * Excalidraw-runtime-free on purpose — the same reason canvas-scene-edit.ts is:
 * minting elements is the caller's job via convertToExcalidrawElements, and
 * keeping this module import-free is what makes it unit-testable (the
 * Excalidraw barrel does not load under jsdom).
 *
 * Two things are done here rather than handed to convertToExcalidrawElements:
 *
 *  - **Arrow bindings.** The skeleton API resolves `start`/`end` only against
 *    elements in the same batch. An agent's most valuable arrow is the one
 *    pointing at a card that is ALREADY on the canvas, so bindings are wired
 *    here uniformly — same-batch and pre-existing take the same path, and the
 *    geometry is computed rather than guessed.
 *  - **Frame membership.** Same reason: a frame drawn around existing cards is
 *    the useful case, and frame membership is just `frameId` on the child.
 *
 * @module pages/canvas/canvas-draw-plan
 */

import type {
  CanvasArrowEndpoint,
  CanvasDrawElement,
  CanvasElementEdit,
  CanvasFontFamily
} from '@memry/contracts/canvas-draw'

import { dropElements, type SceneEditElement } from './canvas-scene-edit'

/** Gap left between a bound arrow's tip and the shape it points at. */
export const ARROW_BINDING_GAP = 4
/** Padding around a frame's children when the caller gives no bounds. */
export const FRAME_PADDING = 32

const DEFAULT_SHAPE_WIDTH = 200
const DEFAULT_SHAPE_HEIGHT = 100
const DEFAULT_ELLIPSE_SIZE = 160

/** A skeleton for convertToExcalidrawElements. Untyped here by design (see module doc). */
export type DrawSkeleton = Record<string, unknown>

export interface DrawPlanOptions {
  /** Excalidraw's FONT_FAMILY numbers, injected so an upstream change is a one-line fix. */
  fontFamily: Record<CanvasFontFamily, number>
  /** ROUNDNESS.ADAPTIVE_RADIUS. */
  adaptiveRadius: number
  newId: () => string
}

export interface PlannedBinding {
  arrowId: string
  startId?: string
  endId?: string
}

export interface PlannedFrame {
  frameId: string
  childIds: string[]
}

export interface DrawPlan {
  skeletons: DrawSkeleton[]
  bindings: PlannedBinding[]
  frames: PlannedFrame[]
  /** Batch ref → minted element id, so the caller can bind to it next time. */
  refs: Record<string, string>
  /** Endpoints and frame children naming something that does not exist. */
  missingIds: string[]
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function defaultSize(type: CanvasDrawElement['type']): { width: number; height: number } {
  if (type === 'ellipse') return { width: DEFAULT_ELLIPSE_SIZE, height: DEFAULT_ELLIPSE_SIZE }
  return { width: DEFAULT_SHAPE_WIDTH, height: DEFAULT_SHAPE_HEIGHT }
}

/**
 * Where a bound arrow touches a shape: the point on the shape's box along the
 * line to the other end, pushed out by the binding gap. Excalidraw recomputes
 * this whenever either shape moves, but only after a move — an arrow whose
 * points were never right looks wrong until the user drags something.
 */
export function edgePoint(rect: Rect, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }

  const halfWidth = rect.width / 2 + ARROW_BINDING_GAP
  const halfHeight = rect.height / 2 + ARROW_BINDING_GAP
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function styleProps(
  spec: CanvasDrawElement | CanvasElementEdit,
  options: Pick<DrawPlanOptions, 'adaptiveRadius'>
): DrawSkeleton {
  const out: DrawSkeleton = {}
  if (spec.strokeColor !== undefined) out.strokeColor = spec.strokeColor
  if (spec.backgroundColor !== undefined) out.backgroundColor = spec.backgroundColor
  if (spec.fillStyle !== undefined) out.fillStyle = spec.fillStyle
  if (spec.strokeWidth !== undefined) out.strokeWidth = spec.strokeWidth
  if (spec.strokeStyle !== undefined) out.strokeStyle = spec.strokeStyle
  if (spec.roughness !== undefined) out.roughness = spec.roughness
  if (spec.opacity !== undefined) out.opacity = spec.opacity
  if (spec.angle !== undefined) out.angle = spec.angle
  if (spec.locked !== undefined) out.locked = spec.locked
  if (spec.link !== undefined) out.link = spec.link ?? null
  if (spec.roundness !== undefined) {
    out.roundness = spec.roundness === 'round' ? { type: options.adaptiveRadius } : null
  }
  return out
}

function textProps(
  spec: {
    fontSize?: number
    fontFamily?: CanvasFontFamily
    textAlign?: string
    verticalAlign?: string
  },
  options: Pick<DrawPlanOptions, 'fontFamily'>
): DrawSkeleton {
  const out: DrawSkeleton = {}
  if (spec.fontSize !== undefined) out.fontSize = spec.fontSize
  if (spec.fontFamily !== undefined) out.fontFamily = options.fontFamily[spec.fontFamily]
  if (spec.textAlign !== undefined) out.textAlign = spec.textAlign
  if (spec.verticalAlign !== undefined) out.verticalAlign = spec.verticalAlign
  return out
}

function arrowhead(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  return value === 'none' ? null : value
}

/**
 * Plan a draw batch. Ids are minted here rather than by
 * convertToExcalidrawElements (which is called with `regenerateIds: false`) so
 * bindings, frame membership and the ref→id map the response returns are all
 * decided in one pure, testable place.
 */
export function planDraw(
  existing: readonly SceneEditElement[],
  specs: readonly CanvasDrawElement[],
  options: DrawPlanOptions
): DrawPlan {
  const existingById = new Map(existing.filter((el) => !el.isDeleted).map((el) => [el.id, el]))
  const refs: Record<string, string> = {}
  const missingIds: string[] = []

  // Ids first: an arrow may point at a ref declared later in the batch.
  const ids = specs.map((spec) => {
    const id = options.newId()
    if (spec.ref) refs[spec.ref] = id
    return id
  })
  const rects = new Map<string, Rect>()
  specs.forEach((spec, index) => {
    const size = defaultSize(spec.type)
    rects.set(ids[index], {
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      width: spec.width ?? size.width,
      height: spec.height ?? size.height
    })
  })

  const resolve = (endpoint: CanvasArrowEndpoint | undefined): string | undefined => {
    if (!endpoint) return undefined
    if (endpoint.ref) {
      const id = refs[endpoint.ref]
      if (!id) missingIds.push(endpoint.ref)
      return id
    }
    const id = endpoint.elementId
    if (id && !existingById.has(id)) {
      missingIds.push(id)
      return undefined
    }
    return id
  }

  const rectOf = (id: string | undefined): Rect | undefined => {
    if (!id) return undefined
    const planned = rects.get(id)
    if (planned) return planned
    const element = existingById.get(id)
    return element
      ? { x: element.x, y: element.y, width: element.width, height: element.height }
      : undefined
  }

  const skeletons: DrawSkeleton[] = []
  const bindings: PlannedBinding[] = []
  const frames: PlannedFrame[] = []

  specs.forEach((spec, index) => {
    const id = ids[index]
    const base: DrawSkeleton = {
      id,
      type: spec.type,
      ...styleProps(spec, options)
    }
    if (spec.label) {
      base.label = {
        text: spec.label.text,
        ...textProps(spec.label, options),
        ...(spec.label.strokeColor ? { strokeColor: spec.label.strokeColor } : {})
      }
    }

    if (spec.type === 'arrow' || spec.type === 'line') {
      const startId = resolve(spec.start)
      const endId = resolve(spec.end)
      const startRect = rectOf(startId)
      const endRect = rectOf(endId)

      let points = spec.points
      let originX = spec.x ?? 0
      let originY = spec.y ?? 0

      if (startRect && endRect) {
        const from = edgePoint(startRect, center(endRect))
        const to = edgePoint(endRect, center(startRect))
        originX = from.x
        originY = from.y
        points = [
          [0, 0],
          [to.x - from.x, to.y - from.y]
        ]
      }
      if (!points) {
        // Nothing to draw from: a zero-length arrow is invisible and unselectable,
        // so fall back to a visible default rather than a scene the user cannot fix.
        points = [
          [0, 0],
          [DEFAULT_SHAPE_WIDTH, 0]
        ]
      }

      const last = points[points.length - 1]
      skeletons.push({
        ...base,
        x: originX,
        y: originY,
        points,
        width: Math.abs(last[0]),
        height: Math.abs(last[1]),
        ...(arrowhead(spec.startArrowhead) !== undefined
          ? { startArrowhead: arrowhead(spec.startArrowhead) }
          : {}),
        ...(arrowhead(spec.endArrowhead) !== undefined
          ? { endArrowhead: arrowhead(spec.endArrowhead) }
          : {})
      })
      if (spec.type === 'arrow' && (startId || endId)) {
        bindings.push({ arrowId: id, startId, endId })
      }
      return
    }

    if (spec.type === 'text') {
      skeletons.push({
        ...base,
        x: spec.x ?? 0,
        y: spec.y ?? 0,
        text: spec.text ?? '',
        ...textProps(spec, options)
      })
      return
    }

    if (spec.type === 'freedraw') {
      const points = spec.points ?? [
        [0, 0],
        [DEFAULT_SHAPE_WIDTH, 0]
      ]
      const xs = points.map((point) => point[0])
      const ys = points.map((point) => point[1])
      skeletons.push({
        ...base,
        x: spec.x ?? 0,
        y: spec.y ?? 0,
        points,
        ...(spec.pressures ? { pressures: spec.pressures, simulatePressure: false } : {}),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      })
      return
    }

    if (spec.type === 'frame') {
      const childIds = (spec.children ?? [])
        .map((child) => {
          const mapped = refs[child]
          if (mapped) return mapped
          if (existingById.has(child)) return child
          missingIds.push(child)
          return null
        })
        .filter((child): child is string => child !== null)

      const bounds = frameBounds(childIds, rectOf)
      const rect: Rect = {
        x: spec.x ?? bounds?.x ?? 0,
        y: spec.y ?? bounds?.y ?? 0,
        width: spec.width ?? bounds?.width ?? DEFAULT_SHAPE_WIDTH,
        height: spec.height ?? bounds?.height ?? DEFAULT_SHAPE_HEIGHT
      }
      rects.set(id, rect)
      skeletons.push({
        ...base,
        ...rect,
        // Only same-batch children: the skeleton API resolves ids against this
        // array alone. Everything else is wired by frameId in applyDrawPlan.
        children: childIds.filter((child) => rects.has(child) && !existingById.has(child)),
        ...(spec.name ? { name: spec.name } : {})
      })
      frames.push({ frameId: id, childIds })
      return
    }

    if (spec.type === 'image') {
      skeletons.push({
        ...base,
        ...(rects.get(id) as Rect),
        fileId: spec.fileId
      })
      return
    }

    if (spec.type === 'embeddable') {
      skeletons.push({
        ...base,
        ...(rects.get(id) as Rect),
        ...(spec.url ? { link: spec.url } : {})
      })
      return
    }

    skeletons.push({ ...base, ...(rects.get(id) as Rect) })
  })

  return { skeletons, bindings, frames, refs, missingIds: [...new Set(missingIds)] }
}

function frameBounds(
  childIds: readonly string[],
  rectOf: (id: string) => Rect | undefined
): Rect | undefined {
  const boxes = childIds.map(rectOf).filter((box): box is Rect => box !== undefined)
  if (boxes.length === 0) return undefined
  const minX = Math.min(...boxes.map((box) => box.x)) - FRAME_PADDING
  const minY = Math.min(...boxes.map((box) => box.y)) - FRAME_PADDING
  const maxX = Math.max(...boxes.map((box) => box.x + box.width)) + FRAME_PADDING
  const maxY = Math.max(...boxes.map((box) => box.y + box.height)) + FRAME_PADDING
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Wire bindings and frame membership onto a converted batch.
 *
 * Bindings are two-sided: the arrow records the shape, and the shape records
 * the arrow in `boundElements`. Writing only the first half produces an arrow
 * that looks attached until the user drags the shape and it stays behind.
 */
export function applyDrawPlan(
  existing: readonly SceneEditElement[],
  created: readonly SceneEditElement[],
  plan: Pick<DrawPlan, 'bindings' | 'frames'>
): SceneEditElement[] {
  const byId = new Map<string, SceneEditElement>()
  for (const element of [...existing, ...created]) byId.set(element.id, { ...element })

  const bindArrow = (arrowId: string, targetId: string, side: 'start' | 'end'): void => {
    const arrow = byId.get(arrowId)
    const target = byId.get(targetId)
    if (!arrow || !target) return
    const binding = { elementId: targetId, focus: 0, gap: ARROW_BINDING_GAP }
    if (side === 'start') arrow.startBinding = binding
    else arrow.endBinding = binding
    const bound = target.boundElements ?? []
    if (!bound.some((entry) => entry.id === arrowId)) {
      target.boundElements = [...bound, { id: arrowId, type: 'arrow' }]
    }
  }

  for (const binding of plan.bindings) {
    if (binding.startId) bindArrow(binding.arrowId, binding.startId, 'start')
    if (binding.endId) bindArrow(binding.arrowId, binding.endId, 'end')
  }

  for (const frame of plan.frames) {
    if (!byId.has(frame.frameId)) continue
    for (const childId of frame.childIds) {
      const child = byId.get(childId)
      if (child) child.frameId = frame.frameId
    }
  }

  return [...existing, ...created].map((element) => byId.get(element.id) ?? element)
}

export interface EditOutcome {
  elements: SceneEditElement[]
  updatedIds: string[]
  deletedIds: string[]
  missingIds: string[]
}

/**
 * Apply patches to elements already on the canvas.
 *
 * Version counters are bumped on every touched element: Excalidraw reconciles
 * by version, so an element edited in place without a bump can be discarded as
 * stale by the next reconcile against another device's copy.
 *
 * Editing a card's TEXT is refused — a card is a window onto a note, and its
 * text lives in the note. The rectangle is otherwise fair game (move it,
 * restyle it, put it in a frame).
 */
export function applyElementEdits(
  elements: readonly SceneEditElement[],
  edits: readonly CanvasElementEdit[],
  options: Pick<DrawPlanOptions, 'adaptiveRadius' | 'fontFamily'>
): EditOutcome {
  const byId = new Map(elements.filter((el) => !el.isDeleted).map((el) => [el.id, el]))
  const missingIds: string[] = []
  const deletedIds: string[] = []
  const patches = new Map<string, DrawSkeleton>()

  // A shape's caption is its own text element pointing back at the shape, so
  // "set the text of this box" has to land on the caption, not the box.
  const labelOf = new Map<string, string>()
  for (const element of byId.values()) {
    if (element.type === 'text' && typeof element.containerId === 'string') {
      labelOf.set(element.containerId, element.id)
    }
  }

  for (const edit of edits) {
    const target = byId.get(edit.elementId)
    if (!target) {
      missingIds.push(edit.elementId)
      continue
    }
    if (edit.delete) {
      deletedIds.push(edit.elementId)
      continue
    }

    const patch: DrawSkeleton = {
      ...styleProps(edit, options),
      ...textProps(edit, options)
    }
    if (edit.x !== undefined) patch.x = edit.x
    if (edit.y !== undefined) patch.y = edit.y
    if (edit.width !== undefined) patch.width = edit.width
    if (edit.height !== undefined) patch.height = edit.height
    if (edit.name !== undefined) patch.name = edit.name
    if (edit.startArrowhead !== undefined) patch.startArrowhead = arrowhead(edit.startArrowhead)
    if (edit.endArrowhead !== undefined) patch.endArrowhead = arrowhead(edit.endArrowhead)

    if (Object.keys(patch).length > 0) {
      patches.set(edit.elementId, { ...(patches.get(edit.elementId) ?? {}), ...patch })
    }

    if (edit.text === undefined) continue
    // A card's text is the note's text; it is not the canvas's to rewrite.
    if (target.customData) continue
    const textId = target.type === 'text' ? target.id : labelOf.get(target.id)
    if (!textId) continue
    patches.set(textId, { ...(patches.get(textId) ?? {}), text: edit.text })
  }

  // A caption cannot outlive its shape: Excalidraw would keep rendering a text
  // element bound to nothing.
  const deleted = new Set(deletedIds)
  for (const id of deletedIds) {
    const labelId = labelOf.get(id)
    if (labelId) deleted.add(labelId)
  }
  const kept = dropElements(elements, deleted)
  const updatedIds: string[] = []
  const next = kept.map((element) => {
    const patch = patches.get(element.id)
    if (!patch || deleted.has(element.id)) return element
    updatedIds.push(element.id)
    return {
      ...element,
      ...patch,
      version: typeof element.version === 'number' ? element.version + 1 : 1,
      updated: Date.now()
    } as SceneEditElement
  })

  return { elements: next, updatedIds, deletedIds, missingIds: [...new Set(missingIds)] }
}
