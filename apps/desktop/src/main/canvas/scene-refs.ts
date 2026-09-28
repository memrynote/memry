/**
 * Main-side extraction of a canvas scene's advisory entity refs.
 *
 * The renderer has its own Excalidraw-typed extractor
 * (`renderer/src/pages/canvas/canvas-cards.ts extractEntityRefs`), but the sync
 * handler runs in main and receives a scene as a JSON string pulled from
 * another device, so it needs an electron-free / Excalidraw-free parser that
 * mirrors the same card contract: a card is a `rectangle` element carrying
 * `customData: { entityType, entityId }`. Deleted elements and non-cards are
 * ignored; refs are deduped by (entityType, entityId).
 *
 * See docs/superpowers/specs/2026-07-17-spatial-canvas-design.md §18 D4 — the
 * advisory `canvas_entity_refs` index must be rebuilt from the incoming scene
 * on every apply, or non-authoring devices never populate it.
 */

import { CANVAS_ENTITY_TYPES, type CanvasEntityRef } from '@memry/contracts/canvas-api'

interface SceneElementLike {
  id?: unknown
  type?: unknown
  isDeleted?: unknown
  customData?: unknown
  startBinding?: unknown
  endBinding?: unknown
  startArrowhead?: unknown
  endArrowhead?: unknown
}

/** One arrow joining two entity cards, oriented the way the arrow points. */
export interface CanvasEntityEdge {
  arrowId: string
  source: CanvasEntityRef
  target: CanvasEntityRef
}

function isEntityType(value: unknown): value is CanvasEntityRef['entityType'] {
  return typeof value === 'string' && (CANVAS_ENTITY_TYPES as readonly string[]).includes(value)
}

function cardRef(element: SceneElementLike): CanvasEntityRef | null {
  if (element.type !== 'rectangle' || element.isDeleted === true) return null
  const data = element.customData
  if (!data || typeof data !== 'object') return null
  const entityType = (data as Record<string, unknown>).entityType
  const entityId = (data as Record<string, unknown>).entityId
  if (!isEntityType(entityType) || typeof entityId !== 'string' || entityId.length === 0) {
    return null
  }
  return { entityType, entityId }
}

function sceneElements(scene: string): SceneElementLike[] {
  if (!scene) return []
  try {
    const elements = (JSON.parse(scene) as { elements?: unknown }).elements
    return Array.isArray(elements) ? (elements as SceneElementLike[]) : []
  } catch {
    return []
  }
}

function boundElementId(binding: unknown): string | null {
  if (!binding || typeof binding !== 'object') return null
  const id = (binding as { elementId?: unknown }).elementId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Parse a serialized Excalidraw scene and return its deduped advisory entity
 * refs. Returns `[]` for an empty string or any scene that fails to parse — an
 * unparseable scene must never throw inside the sync apply transaction.
 */
export function extractEntityRefsFromScene(scene: string): CanvasEntityRef[] {
  const seen = new Set<string>()
  const refs: CanvasEntityRef[] = []
  for (const element of sceneElements(scene)) {
    const ref = cardRef(element)
    if (!ref) continue
    const key = `${ref.entityType}:${ref.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

/**
 * Every live arrow whose two ends are bound to two different entity cards.
 *
 * An arrow ending on a plain shape, on text, or on nothing is not a
 * connection, and neither is one that loops back to the card it left (the same
 * entity at both ends, even through two cards of it). Direction follows the
 * arrowheads: an arrow drawn with its only head at the start points the other
 * way, so its ends are swapped. Heads on both ends or on neither keep the
 * drawing order. Same never-throw contract as `extractEntityRefsFromScene`.
 */
export function extractEntityEdgesFromScene(scene: string): CanvasEntityEdge[] {
  const elements = sceneElements(scene)
  const cardsById = new Map<string, CanvasEntityRef>()
  for (const element of elements) {
    const ref = cardRef(element)
    if (ref && typeof element.id === 'string') cardsById.set(element.id, ref)
  }
  if (cardsById.size < 2) return []

  const edges: CanvasEntityEdge[] = []
  const seenArrows = new Set<string>()
  for (const element of elements) {
    if (element.type !== 'arrow' || element.isDeleted === true) continue
    if (typeof element.id !== 'string' || element.id.length === 0) continue
    if (seenArrows.has(element.id)) continue
    const startId = boundElementId(element.startBinding)
    const endId = boundElementId(element.endBinding)
    const start = startId ? cardsById.get(startId) : undefined
    const end = endId ? cardsById.get(endId) : undefined
    if (!start || !end) continue
    if (start.entityType === end.entityType && start.entityId === end.entityId) continue

    const reversed = element.startArrowhead != null && element.endArrowhead == null
    seenArrows.add(element.id)
    edges.push({
      arrowId: element.id,
      source: reversed ? end : start,
      target: reversed ? start : end
    })
  }
  return edges
}
