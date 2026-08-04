/**
 * Pure scene edits for agent-driven card add/remove.
 *
 * Shared by both MCP write paths (live editor and headless), so it stays
 * Excalidraw-runtime-free: minting elements is the caller's job via
 * convertToExcalidrawElements, the only thing that correctly produces ids,
 * seeds, version counters and fractional indices.
 *
 * See docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §4.3.
 */

import type { CanvasEntityRef, CanvasEntityType } from '@memry/contracts/canvas-api'
import {
  CARD_DEFAULT_HEIGHT,
  CARD_DEFAULT_WIDTH,
  findFreeCardCenter,
  getCardRefs,
  makeCardSkeleton,
  type CanvasCardRef,
  type CardElement,
  type CardSkeleton,
  type SceneRect
} from './canvas-cards'

/**
 * Element fields the agent write paths rewrite, beyond the card basics. Still a
 * deliberate subset of ExcalidrawElement — the index signature carries the rest
 * through untouched, which is what lets these modules edit a scene written by a
 * newer Excalidraw without dropping fields they never heard of.
 */
export interface SceneEditElement extends CardElement {
  boundElements?: { id: string; type: string }[] | null
  startBinding?: { elementId: string; focus?: number; gap?: number } | null
  endBinding?: { elementId: string; focus?: number; gap?: number } | null
  /** The frame this element belongs to. */
  frameId?: string | null
  /** The element this text is bound to (a shape or arrow label). */
  containerId?: string | null
  text?: string
  [key: string]: unknown
}

/**
 * Drop elements by id and repair what pointed at them.
 *
 * Three places reference an element: the element itself, the start/end binding
 * on any arrow bound to it, and the boundElements array on elements it was
 * bound to. Missing the last two leaves arrows bound to elements that no longer
 * exist, which Excalidraw either silently repairs or does not.
 */
export function dropElements(
  elements: readonly SceneEditElement[],
  ids: ReadonlySet<string>
): SceneEditElement[] {
  if (ids.size === 0) return [...elements]

  return elements
    .filter((element) => !ids.has(element.id))
    .map((element) => {
      const patch: Partial<SceneEditElement> = {}
      if (element.startBinding && ids.has(element.startBinding.elementId)) {
        patch.startBinding = null
      }
      if (element.endBinding && ids.has(element.endBinding.elementId)) {
        patch.endBinding = null
      }
      if (element.boundElements?.some((bound) => ids.has(bound.id))) {
        patch.boundElements = element.boundElements.filter((bound) => !ids.has(bound.id))
      }
      return Object.keys(patch).length > 0 ? { ...element, ...patch } : element
    })
}

/**
 * The scene's occupied area, standing in for a viewport the headless path does
 * not have. Placing relative to existing content keeps a new card beside the
 * user's work instead of at an arbitrary origin.
 */
export function sceneBoundsRect(elements: readonly CardElement[]): SceneRect {
  const live = elements.filter((element) => !element.isDeleted)
  if (live.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  return live.reduce<SceneRect>(
    (rect, element) => ({
      minX: Math.min(rect.minX, element.x),
      minY: Math.min(rect.minY, element.y),
      maxX: Math.max(rect.maxX, element.x + element.width),
      maxY: Math.max(rect.maxY, element.y + element.height)
    }),
    {
      minX: live[0].x,
      minY: live[0].y,
      maxX: live[0].x + live[0].width,
      maxY: live[0].y + live[0].height
    }
  )
}

export interface CardPlacementInput {
  entityType: CanvasEntityType
  entityId: string
  width?: number
  height?: number
}

/**
 * Skeletons for a batch of new cards, each placed in the first free cell of a
 * grid spiralling out from the scene's centre. Occupancy accumulates across the
 * batch so two cards added in one call never land on each other (#871).
 */
export function planCardPlacements(
  elements: readonly CardElement[],
  items: readonly CardPlacementInput[]
): CardSkeleton[] {
  const rect = sceneBoundsRect(elements)
  const occupied: CanvasCardRef[] = [...getCardRefs(elements)]

  return items.map((item) => {
    const width = item.width ?? CARD_DEFAULT_WIDTH
    const height = item.height ?? CARD_DEFAULT_HEIGHT
    const center = findFreeCardCenter(occupied, rect, { width, height })
    occupied.push({
      elementId: '',
      entityType: item.entityType,
      entityId: item.entityId,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      angle: 0
    })
    return makeCardSkeleton({
      entityType: item.entityType,
      entityId: item.entityId,
      centerX: center.x,
      centerY: center.y,
      width,
      height
    })
  })
}

/** Drop every card rectangle for one entity, repairing what pointed at it. */
export function removeCardElements(
  elements: readonly SceneEditElement[],
  ref: CanvasEntityRef
): { elements: SceneEditElement[]; removedIds: string[] } {
  const removedIds = getCardRefs(elements)
    .filter((card) => card.entityType === ref.entityType && card.entityId === ref.entityId)
    .map((card) => card.elementId)

  return { elements: dropElements(elements, new Set(removedIds)), removedIds }
}
