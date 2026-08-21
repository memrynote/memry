/**
 * Structural read of a canvas scene, for agents that draw on it.
 *
 * `summary.ts` answers "what is ON this canvas" and deliberately returns no
 * geometry — that is the right read for an agent reasoning about entities. An
 * agent that has to PLACE something needs the opposite: where things are, how
 * big they are, and which element id to bind an arrow to. This produces that,
 * and still drops the seed/version/versionNonce/index bookkeeping that makes a
 * raw scene unreadable.
 *
 * Excalidraw-free (plain JSON parsing) so it runs in main and unit-tests
 * without the library, same as summary.ts.
 *
 * @module canvas/elements
 */

import { CANVAS_ENTITY_TYPES } from '@memry/contracts/canvas-api'
import type { CanvasElementView } from '@memry/contracts/canvas-draw'

/** Most elements returned for one canvas. */
export const MAX_ELEMENT_VIEWS = 1000

export interface CanvasSceneElements {
  elements: CanvasElementView[]
  /** Live (non-deleted) elements in the scene, before the cap. */
  elementCount: number
  truncated: boolean
}

interface RawElement {
  id?: unknown
  type?: unknown
  isDeleted?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  angle?: unknown
  text?: unknown
  strokeColor?: unknown
  backgroundColor?: unknown
  link?: unknown
  customData?: unknown
  startBinding?: unknown
  endBinding?: unknown
  frameId?: unknown
  containerId?: unknown
  boundElements?: unknown
  name?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The deep link a saved mind-map box carries. See `mind-map-hover.ts`. */
function mindMapHref(customData: unknown): string | undefined {
  if (typeof customData !== 'object' || customData === null) return undefined
  return str((customData as { memryHref?: unknown }).memryHref)
}

function bindingId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  return str((value as { elementId?: unknown }).elementId)
}

function entityRef(value: unknown): { entityType?: string; entityId?: string } {
  if (!value || typeof value !== 'object') return {}
  const data = value as Record<string, unknown>
  const entityType = str(data.entityType)
  const entityId = str(data.entityId)
  if (!entityType || !entityId) return {}
  if (!(CANVAS_ENTITY_TYPES as readonly string[]).includes(entityType)) return {}
  return { entityType, entityId }
}

/**
 * Bound text lives in its own `text` element pointing back at its container,
 * so a label is only visible after a second pass. Resolving it here is what
 * lets a caller read "the box that says Chapter 3" instead of a box and a
 * loose string it has to re-associate by coordinates.
 */
function labelsByContainer(elements: readonly RawElement[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const element of elements) {
    if (element.isDeleted === true || element.type !== 'text') continue
    const containerId = str(element.containerId)
    const text = str(element.text)
    if (containerId && text) labels.set(containerId, text)
  }
  return labels
}

export function readSceneElements(scene: string): CanvasSceneElements {
  const empty: CanvasSceneElements = { elements: [], elementCount: 0, truncated: false }
  if (!scene) return empty

  let raw: unknown
  try {
    raw = (JSON.parse(scene) as { elements?: unknown }).elements
  } catch {
    return empty
  }
  if (!Array.isArray(raw)) return empty

  const all = raw as RawElement[]
  const labels = labelsByContainer(all)
  const views: CanvasElementView[] = []
  let elementCount = 0

  for (const element of all) {
    if (element.isDeleted === true) continue
    elementCount++

    const id = str(element.id)
    const type = str(element.type)
    if (!id || !type) continue
    // A label's own text element is reported through its container, not twice.
    if (type === 'text' && str(element.containerId)) continue
    if (views.length >= MAX_ELEMENT_VIEWS) continue

    const view: CanvasElementView = {
      id,
      type,
      x: num(element.x),
      y: num(element.y),
      width: num(element.width),
      height: num(element.height),
      ...entityRef(element.customData)
    }

    const angle = element.angle
    if (typeof angle === 'number' && angle !== 0) view.angle = angle
    const text = str(element.text)
    if (text) view.text = text
    const label = labels.get(id)
    if (label) view.label = label
    const strokeColor = str(element.strokeColor)
    if (strokeColor) view.strokeColor = strokeColor
    const backgroundColor = str(element.backgroundColor)
    if (backgroundColor) view.backgroundColor = backgroundColor
    // A box saved from a note's mind map keeps its `memry://` href in
    // `customData` rather than in `link` — the drawing library paints a
    // permanent glyph for the latter, and a map is nothing but linked boxes
    // (see `mind-map-snapshot.ts`). Where it is stored is a rendering concern;
    // a reader asking what this element points at wants the same answer either
    // way.
    const link = str(element.link) ?? mindMapHref(element.customData)
    if (link) view.link = link
    const startElementId = bindingId(element.startBinding)
    if (startElementId) view.startElementId = startElementId
    const endElementId = bindingId(element.endBinding)
    if (endElementId) view.endElementId = endElementId
    const frameId = str(element.frameId)
    if (frameId) view.frameId = frameId
    const name = str(element.name)
    if (name) view.name = name

    views.push(view)
  }

  return {
    elements: views,
    elementCount,
    truncated: views.length >= MAX_ELEMENT_VIEWS && elementCount > views.length
  }
}
