/**
 * Pure geometry + data helpers for spatial-canvas item cards.
 *
 * A card is an Excalidraw `rectangle` carrying
 * `customData: { entityType, entityId }`. The scene stays the source of truth
 * for geometry; a DOM overlay (canvas-card-overlay.tsx) renders a read-only
 * preview over each visible card rectangle. Everything here is
 * Excalidraw-runtime-free (types only) so it unit-tests without the library.
 */

import {
  CANVAS_ENTITY_TYPES,
  type CanvasEntityRef,
  type CanvasEntityType
} from '@memry/contracts/canvas-api'

/** The custom drag MIME a card drop consumes ({ entityType, entityId } JSON). */
export const CANVAS_ITEM_DRAG_MIME = 'application/x-memry-canvas-item'

/** Default card rectangle size in scene units. */
export const CARD_DEFAULT_WIDTH = 260
export const CARD_DEFAULT_HEIGHT = 168

/** Minimal element shape the card logic reads (subset of ExcalidrawElement). */
export interface CardElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  isDeleted?: boolean
  customData?: Record<string, unknown> | null
}

/** Minimal appState shape the overlay reads. */
export interface CanvasAppStateView {
  scrollX: number
  scrollY: number
  zoom: { value: number }
}

/** A card resolved from a scene element: its element id + the entity it refs. */
export interface CanvasCardRef extends CanvasEntityRef {
  elementId: string
  x: number
  y: number
  width: number
  height: number
  angle: number
}

function isEntityType(value: unknown): value is CanvasEntityType {
  return typeof value === 'string' && (CANVAS_ENTITY_TYPES as readonly string[]).includes(value)
}

/**
 * Reads the card data off a rectangle element, or null when the element is not
 * a live card (wrong type, deleted, or missing/invalid customData).
 */
export function getCardRef(element: CardElement): CanvasCardRef | null {
  if (element.type !== 'rectangle' || element.isDeleted) {
    return null
  }
  const data = element.customData
  if (!data) {
    return null
  }
  const entityType = data.entityType
  const entityId = data.entityId
  if (!isEntityType(entityType) || typeof entityId !== 'string' || entityId.length === 0) {
    return null
  }
  return {
    elementId: element.id,
    entityType,
    entityId,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    angle: element.angle ?? 0
  }
}

/** All live card refs in a scene, in z-order (elements array order). */
export function getCardRefs(elements: readonly CardElement[]): CanvasCardRef[] {
  const cards: CanvasCardRef[] = []
  for (const element of elements) {
    const card = getCardRef(element)
    if (card) {
      cards.push(card)
    }
  }
  return cards
}

/**
 * The one derivation of an entity's string identity. Everything that keys a
 * Map/Set by (entityType, entityId) — ref dedup, the resolved-entity map, the
 * picker's "already on canvas" check — goes through here so the shapes cannot
 * drift apart.
 */
export function entityKey(entityType: CanvasEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
}

/**
 * Advisory entity refs for persistence, deduped by (entityType, entityId).
 * The store rewrites canvas_entity_refs from this on every save.
 */
export function extractEntityRefs(elements: readonly CardElement[]): CanvasEntityRef[] {
  const seen = new Set<string>()
  const refs: CanvasEntityRef[] = []
  for (const card of getCardRefs(elements)) {
    const key = entityKey(card.entityType, card.entityId)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    refs.push({ entityType: card.entityType, entityId: card.entityId })
  }
  return refs
}

/**
 * CSS transform for the overlay layer so its children, positioned in scene
 * units, land exactly over the canvas. Mirrors Excalidraw's
 * sceneCoordsToViewportCoords: viewportX = (sceneX + scrollX) * zoom.
 * Applied with transform-origin: 0 0.
 */
export function overlayTransform(appState: CanvasAppStateView): string {
  const z = appState.zoom.value
  return `translate(${appState.scrollX * z}px, ${appState.scrollY * z}px) scale(${z})`
}

export interface SceneRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The visible viewport expressed in scene coordinates. */
export function viewportSceneRect(
  appState: CanvasAppStateView,
  container: { width: number; height: number }
): SceneRect {
  const z = appState.zoom.value || 1
  return {
    minX: -appState.scrollX,
    minY: -appState.scrollY,
    maxX: container.width / z - appState.scrollX,
    maxY: container.height / z - appState.scrollY
  }
}

function intersects(card: CanvasCardRef, rect: SceneRect, padding: number): boolean {
  return (
    card.x <= rect.maxX + padding &&
    card.x + card.width >= rect.minX - padding &&
    card.y <= rect.maxY + padding &&
    card.y + card.height >= rect.minY - padding
  )
}

export interface VisibilityOptions {
  /** Scene-unit padding for a card to ENTER the visible set. */
  enterPadding: number
  /** Larger scene-unit padding for a visible card to STAY visible (hysteresis). */
  exitPadding: number
  /** Element ids currently mounted, so membership only flips at the thresholds. */
  previousVisible: ReadonlySet<string>
}

/**
 * Viewport-membership with hysteresis: a card enters when it intersects the
 * viewport + enterPadding and only leaves once it exits viewport + exitPadding.
 * The wider exit band stops cards near the edge from mounting/unmounting on
 * every sub-pixel pan.
 */
export function computeVisibleCardIds(
  cards: readonly CanvasCardRef[],
  rect: SceneRect,
  options: VisibilityOptions
): Set<string> {
  const visible = new Set<string>()
  for (const card of cards) {
    const wasVisible = options.previousVisible.has(card.elementId)
    const padding = wasVisible ? options.exitPadding : options.enterPadding
    if (intersects(card, rect, padding)) {
      visible.add(card.elementId)
    }
  }
  return visible
}

/** Two id sets are equal (same membership). */
export function sameMembership(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

/** Rectangle-skeleton input for convertToExcalidrawElements (card creation). */
export interface CardSkeleton {
  type: 'rectangle'
  x: number
  y: number
  width: number
  height: number
  strokeColor: string
  backgroundColor: string
  fillStyle: string
  strokeWidth: number
  roughness: number
  roundness: { type: number }
  customData: { entityType: CanvasEntityType; entityId: string }
}

/**
 * A clean (roughness 0) rectangle skeleton for a card, centered on (x, y).
 * Pass to convertToExcalidrawElements. The overlay draws the real preview;
 * this rectangle provides geometry, selection, resize, and arrow-binding.
 */
export function makeCardSkeleton(input: {
  entityType: CanvasEntityType
  entityId: string
  /** Scene coordinate to center the card on (e.g. the drop point). */
  centerX: number
  centerY: number
  width?: number
  height?: number
}): CardSkeleton {
  const width = input.width ?? CARD_DEFAULT_WIDTH
  const height = input.height ?? CARD_DEFAULT_HEIGHT
  return {
    type: 'rectangle',
    x: input.centerX - width / 2,
    y: input.centerY - height / 2,
    width,
    height,
    strokeColor: '#ced4da',
    // Solid (non-transparent) fill so the WHOLE card interior is a binding +
    // selection target: Excalidraw only hit-tests a transparent shape on its
    // outline, which would make arrows bind (and drags grab) a card only at its
    // border. The opaque DOM overlay fully covers the rectangle (its rounded
    // corners are tighter than the overlay's), so the fill is never visible.
    backgroundColor: '#ffffff',
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
    roundness: { type: 3 },
    customData: { entityType: input.entityType, entityId: input.entityId }
  }
}

/**
 * Parses the canvas drag payload from a DataTransfer-like getData function.
 * Returns null when the drag is not a canvas item (no MIME / bad JSON).
 */
export function readCanvasDragItem(
  getData: (type: string) => string
): { entityType: CanvasEntityType; entityId: string } | null {
  const raw = getData(CANVAS_ITEM_DRAG_MIME)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { entityType?: unknown; entityId?: unknown }
    if (isEntityType(parsed.entityType) && typeof parsed.entityId === 'string' && parsed.entityId) {
      return { entityType: parsed.entityType, entityId: parsed.entityId }
    }
  } catch {
    return null
  }
  return null
}

/** Serializes a canvas drag payload for dataTransfer.setData. */
export function canvasDragPayload(entityType: CanvasEntityType, entityId: string): string {
  return JSON.stringify({ entityType, entityId })
}

/**
 * Locale-formatted event time for card/picker display, e.g. "Jul 20 · 9:30 AM"
 * or "Jul 20 · All day". Shared by CanvasCard and the Add-card picker so
 * there is one date formatter, not two.
 */
export function formatEventTime(startAt: string, isAllDay: boolean, allDayLabel: string): string {
  const parsed = new Date(startAt)
  if (Number.isNaN(parsed.getTime())) return startAt
  const date = parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (isAllDay) return `${date} · ${allDayLabel}`
  const time = parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}
