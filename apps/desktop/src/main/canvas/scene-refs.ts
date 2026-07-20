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
  type?: unknown
  isDeleted?: unknown
  customData?: unknown
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

/**
 * Parse a serialized Excalidraw scene and return its deduped advisory entity
 * refs. Returns `[]` for an empty string or any scene that fails to parse — an
 * unparseable scene must never throw inside the sync apply transaction.
 */
export function extractEntityRefsFromScene(scene: string): CanvasEntityRef[] {
  if (!scene) return []

  let elements: unknown
  try {
    const parsed = JSON.parse(scene) as { elements?: unknown }
    elements = parsed.elements
  } catch {
    return []
  }
  if (!Array.isArray(elements)) return []

  const seen = new Set<string>()
  const refs: CanvasEntityRef[] = []
  for (const element of elements as SceneElementLike[]) {
    const ref = cardRef(element)
    if (!ref) continue
    const key = `${ref.entityType}:${ref.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}
