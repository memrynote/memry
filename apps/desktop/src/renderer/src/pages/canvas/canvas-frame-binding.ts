/**
 * Pure helpers for frames bound to a category (#2483).
 *
 * A frame is Excalidraw's own `frame` element. Binding one to a tag, or to one
 * value of a select / multi-select / status property, stores that binding in
 * the frame's `customData` under `memryBinding`. A card whose `frameId` points
 * at a bound frame is "in" that category, and dropping a card into the frame is
 * what writes the category onto the card's note or task.
 *
 * Compat: only the frame's `customData` gains a key. An older build renders a
 * plain frame and keeps the key (Excalidraw restores `customData` verbatim),
 * so a round trip through an older device does not drop the binding.
 *
 * Excalidraw-runtime-free (types only) so it unit-tests without the library.
 *
 * @module pages/canvas/canvas-frame-binding
 */

import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import {
  DEFAULT_STATUS_CATEGORIES,
  STATUS_CATEGORY_KEYS,
  type StatusCategories
} from '@memry/contracts/property-types'
import { getCardRef, type CardElement } from './canvas-cards'

/** The `customData` key a bound frame carries. */
export const FRAME_BINDING_KEY = 'memryBinding'

export type BindablePropertyType = 'select' | 'multiselect' | 'status'

const BINDABLE_PROPERTY_TYPES: readonly string[] = ['select', 'multiselect', 'status']

export function isBindablePropertyType(type: string): type is BindablePropertyType {
  return BINDABLE_PROPERTY_TYPES.includes(type)
}

export type FrameBinding =
  | { kind: 'tag'; tag: string }
  | {
      kind: 'property'
      property: string
      value: string
      propertyType: BindablePropertyType
    }

/**
 * The option values of a select, multi-select or status definition, in the
 * order the property editor shows them. `optionsJson` is the index row's
 * column: a bare option array for select types, `{ categories }` for status —
 * the same shapes main writes (see vault/property-definitions.ts). A status
 * row without categories has the defaults, as it does everywhere else.
 */
export function definitionOptionValues(
  type: BindablePropertyType,
  optionsJson: string | null
): string[] {
  let parsed: unknown = null
  if (optionsJson) {
    try {
      parsed = JSON.parse(optionsJson)
    } catch {
      parsed = null
    }
  }
  if (type === 'status') {
    const categories =
      (parsed as { categories?: StatusCategories } | null)?.categories ?? DEFAULT_STATUS_CATEGORIES
    return STATUS_CATEGORY_KEYS.flatMap((key) =>
      (categories[key]?.options ?? []).map((option) => option.value)
    ).filter(nonEmptyString)
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((option: unknown) =>
      typeof option === 'string'
        ? option
        : typeof option === 'object' && option !== null
          ? (option as { value?: unknown }).value
          : null
    )
    .filter(nonEmptyString)
}

/** The scene element fields this module reads. */
export interface FrameSceneElement extends CardElement {
  frameId?: string | null
  name?: string | null
  version?: number
  versionNonce?: number
  updated?: number
}

/**
 * An element with `patch` applied and its version bumped. Excalidraw's history
 * and reconcile both tell a changed element from an unchanged one by version,
 * so an edit without the bump can be dropped as stale or be missing from undo.
 */
export function bumpElement<T extends FrameSceneElement>(element: T, patch: Partial<T>): T {
  return {
    ...element,
    ...patch,
    version: (element.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now()
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Reads a binding off a frame's `customData`. Anything malformed reads as
 * unbound: a frame written by a newer build with a binding kind this build does
 * not know stays a plain frame here rather than categorizing cards wrongly.
 */
export function readFrameBinding(customData: unknown): FrameBinding | null {
  if (typeof customData !== 'object' || customData === null) return null
  const raw = (customData as Record<string, unknown>)[FRAME_BINDING_KEY]
  if (typeof raw !== 'object' || raw === null) return null
  const binding = raw as Record<string, unknown>
  if (binding.kind === 'tag' && nonEmptyString(binding.tag)) {
    return { kind: 'tag', tag: binding.tag }
  }
  if (
    binding.kind === 'property' &&
    nonEmptyString(binding.property) &&
    nonEmptyString(binding.value) &&
    typeof binding.propertyType === 'string' &&
    isBindablePropertyType(binding.propertyType)
  ) {
    return {
      kind: 'property',
      property: binding.property,
      value: binding.value,
      propertyType: binding.propertyType
    }
  }
  return null
}

/**
 * The frame's `customData` with the binding set (or removed when `binding` is
 * null). Every other key is kept, so data another feature — or a newer build —
 * put there survives a rebind.
 */
export function withFrameBinding(
  customData: unknown,
  binding: FrameBinding | null
): Record<string, unknown> | undefined {
  const base =
    typeof customData === 'object' && customData !== null
      ? { ...(customData as Record<string, unknown>) }
      : {}
  if (binding) {
    base[FRAME_BINDING_KEY] = { ...binding }
  } else {
    delete base[FRAME_BINDING_KEY]
  }
  return Object.keys(base).length > 0 ? base : undefined
}

export function sameBinding(a: FrameBinding | null, b: FrameBinding | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag.toLowerCase() === b.tag.toLowerCase()
  if (a.kind === 'property' && b.kind === 'property') {
    return a.property === b.property && a.value === b.value
  }
  return false
}

/** How a binding reads on the frame: `#health/sleep` or `Status: Done`. */
export function bindingLabel(binding: FrameBinding): string {
  return binding.kind === 'tag' ? `#${binding.tag}` : `${binding.property}: ${binding.value}`
}

export interface FrameView {
  id: string
  x: number
  y: number
  width: number
  height: number
  name: string | null
  binding: FrameBinding | null
  /** Live cards whose `frameId` is this frame. */
  cardCount: number
}

function isLiveFrame(element: FrameSceneElement): boolean {
  return element.type === 'frame' && !element.isDeleted
}

/** Every live frame in the scene with its binding and card count. */
export function getFrames(elements: readonly FrameSceneElement[]): FrameView[] {
  const counts = new Map<string, number>()
  for (const element of elements) {
    if (!element.frameId || !getCardRef(element)) continue
    counts.set(element.frameId, (counts.get(element.frameId) ?? 0) + 1)
  }
  const frames: FrameView[] = []
  for (const element of elements) {
    if (!isLiveFrame(element)) continue
    frames.push({
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      name: typeof element.name === 'string' ? element.name : null,
      binding: readFrameBinding(element.customData),
      cardCount: counts.get(element.id) ?? 0
    })
  }
  return frames
}

/** Bindings of the live bound frames, keyed by frame id. */
export function getFrameBindings(
  elements: readonly FrameSceneElement[]
): Map<string, FrameBinding> {
  const bindings = new Map<string, FrameBinding>()
  for (const element of elements) {
    if (!isLiveFrame(element)) continue
    const binding = readFrameBinding(element.customData)
    if (binding) bindings.set(element.id, binding)
  }
  return bindings
}

export interface CardPlacement {
  entityType: CanvasEntityType
  entityId: string
  frameId: string | null
  x: number
  y: number
}

/** Where every live card sits and which frame holds it, keyed by element id. */
export function cardMembership(elements: readonly FrameSceneElement[]): Map<string, CardPlacement> {
  const membership = new Map<string, CardPlacement>()
  for (const element of elements) {
    const card = getCardRef(element)
    if (!card) continue
    membership.set(card.elementId, {
      entityType: card.entityType,
      entityId: card.entityId,
      frameId: element.frameId ?? null,
      x: element.x,
      y: element.y
    })
  }
  return membership
}

export interface MembershipChange {
  elementId: string
  entityType: CanvasEntityType
  entityId: string
  fromFrameId: string | null
  toFrameId: string | null
  /** Where the card was before the change; null for a card that just appeared. */
  before: { x: number; y: number } | null
}

/**
 * Cards whose frame changed between two snapshots. A card that appears already
 * inside a frame (dropped from the sidebar onto it, pasted into it) counts as
 * entering it. A card that disappeared is not a change: deleting a card, or a
 * frame together with its cards, must never strip anything off the entity.
 */
export function diffMembership(
  previous: ReadonlyMap<string, CardPlacement>,
  next: ReadonlyMap<string, CardPlacement>
): MembershipChange[] {
  const changes: MembershipChange[] = []
  for (const [elementId, placement] of next) {
    const before = previous.get(elementId)
    const fromFrameId = before?.frameId ?? null
    if (before ? fromFrameId === placement.frameId : placement.frameId === null) continue
    changes.push({
      elementId,
      entityType: placement.entityType,
      entityId: placement.entityId,
      fromFrameId,
      toFrameId: placement.frameId,
      before: before ? { x: before.x, y: before.y } : null
    })
  }
  return changes
}

// ============================================================================
// Category math
// ============================================================================

/** The tag list with `tag` added, or null when it is already there. */
export function addTag(tags: readonly string[], tag: string): string[] | null {
  const key = tag.toLowerCase()
  if (tags.some((existing) => existing.toLowerCase() === key)) return null
  return [...tags, tag]
}

/** The tag list without `tag`, or null when it was not there. */
export function removeTag(tags: readonly string[], tag: string): string[] | null {
  const key = tag.toLowerCase()
  const next = tags.filter((existing) => existing.toLowerCase() !== key)
  return next.length === tags.length ? null : next
}

function asValueList(current: unknown): string[] {
  if (Array.isArray(current)) return current.filter((v): v is string => typeof v === 'string')
  if (typeof current === 'string' && current.length > 0) return [current]
  return []
}

/** Marker for "the write would change nothing". */
export const UNCHANGED: unique symbol = Symbol('unchanged')

/**
 * The property value after putting the bound value on it. A select or status
 * holds one value, so the bound one replaces whatever was there; a
 * multi-select gains it alongside the others.
 */
export function addPropertyValue(
  current: unknown,
  binding: Extract<FrameBinding, { kind: 'property' }>
): unknown {
  if (binding.propertyType === 'multiselect') {
    const values = asValueList(current)
    return values.includes(binding.value) ? UNCHANGED : [...values, binding.value]
  }
  return current === binding.value ? UNCHANGED : binding.value
}

/**
 * The property value after taking the bound value off it. A single-value
 * property is only cleared when it still holds the bound value: someone may
 * have changed it since, and that change is not ours to undo.
 */
export function removePropertyValue(
  current: unknown,
  binding: Extract<FrameBinding, { kind: 'property' }>
): unknown {
  if (binding.propertyType === 'multiselect') {
    const values = asValueList(current)
    if (!values.includes(binding.value)) return UNCHANGED
    const next = values.filter((value) => value !== binding.value)
    return next.length > 0 ? next : null
  }
  return current === binding.value ? null : UNCHANGED
}

/** Whether a card's entity carries this value of the bound property. */
export function hasPropertyValue(current: unknown, value: string): boolean {
  return asValueList(current).includes(value)
}

export type CategorizeSkipReason = 'file' | 'taskProperty' | 'unsupported'

/**
 * Why a card cannot take a binding, or null when it can. Files have no
 * frontmatter to write into; tasks have tags but no note properties; events
 * and projects carry neither.
 */
export function categorizeSkipReason(
  entityType: CanvasEntityType,
  binding: FrameBinding
): CategorizeSkipReason | null {
  if (entityType === 'note') return null
  if (entityType === 'task') return binding.kind === 'tag' ? null : 'taskProperty'
  if (entityType === 'file') return 'file'
  return 'unsupported'
}

// ============================================================================
// "Lay out by property"
// ============================================================================

/** Inner padding between a frame's edge and its cards. */
export const LAYOUT_FRAME_PADDING = 40
/** Gap between cards inside a frame. */
export const LAYOUT_CARD_GAP = 24
/** Gap between frames. */
export const LAYOUT_FRAME_GAP = 120
/** Size of a frame no card landed in, so it is still a target to drop onto. */
export const LAYOUT_EMPTY_FRAME = { width: 360, height: 240 }

export interface LayoutCard {
  elementId: string
  width: number
  height: number
  /** The values the card's entity holds for the property, in its own order. */
  values: readonly string[]
}

export interface PlannedLayoutFrame {
  value: string
  x: number
  y: number
  width: number
  height: number
  childIds: string[]
}

export interface LayoutPlan {
  frames: PlannedLayoutFrame[]
  /** New top-left for every card that moves into a frame. */
  moves: Map<string, { x: number; y: number }>
}

/**
 * One frame per option value, laid out left to right from `origin`, with every
 * card placed in the frame of the first option it holds. A multi-select card
 * holding two options goes to the frame of the earlier OPTION, not the earlier
 * value on the card, so the result does not depend on the order values were
 * added in. Cards holding none of the options stay where they are.
 *
 * Cards in a frame form a near-square grid, each cell sized to the frame's
 * largest card so rows and columns line up.
 */
export function planPropertyLayout(input: {
  options: readonly string[]
  cards: readonly LayoutCard[]
  origin: { x: number; y: number }
}): LayoutPlan {
  const buckets = new Map<string, LayoutCard[]>()
  for (const option of input.options) buckets.set(option, [])
  for (const card of input.cards) {
    const option = input.options.find((candidate) => card.values.includes(candidate))
    if (option) buckets.get(option)!.push(card)
  }

  const frames: PlannedLayoutFrame[] = []
  const moves = new Map<string, { x: number; y: number }>()
  let cursorX = input.origin.x

  for (const [value, cards] of buckets) {
    const x = cursorX
    const y = input.origin.y
    if (cards.length === 0) {
      frames.push({ value, x, y, ...LAYOUT_EMPTY_FRAME, childIds: [] })
      cursorX += LAYOUT_EMPTY_FRAME.width + LAYOUT_FRAME_GAP
      continue
    }
    const columns = Math.ceil(Math.sqrt(cards.length))
    const rows = Math.ceil(cards.length / columns)
    const cellWidth = Math.max(...cards.map((card) => card.width))
    const cellHeight = Math.max(...cards.map((card) => card.height))
    cards.forEach((card, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      moves.set(card.elementId, {
        x: x + LAYOUT_FRAME_PADDING + column * (cellWidth + LAYOUT_CARD_GAP),
        y: y + LAYOUT_FRAME_PADDING + row * (cellHeight + LAYOUT_CARD_GAP)
      })
    })
    const width = LAYOUT_FRAME_PADDING * 2 + columns * cellWidth + (columns - 1) * LAYOUT_CARD_GAP
    const height = LAYOUT_FRAME_PADDING * 2 + rows * cellHeight + (rows - 1) * LAYOUT_CARD_GAP
    frames.push({ value, x, y, width, height, childIds: cards.map((card) => card.elementId) })
    cursorX += width + LAYOUT_FRAME_GAP
  }

  return { frames, moves }
}

/**
 * Where a layout starts: to the right of everything already drawn, top-aligned
 * with it, so new frames never land on top of existing work. An empty scene
 * starts at `fallback` (the viewport centre).
 */
export function layoutOrigin(
  elements: readonly FrameSceneElement[],
  fallback: { x: number; y: number }
): { x: number; y: number } {
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  for (const element of elements) {
    if (element.isDeleted) continue
    maxX = Math.max(maxX, element.x + element.width)
    minY = Math.min(minY, element.y)
  }
  if (!Number.isFinite(maxX) || !Number.isFinite(minY)) return fallback
  return { x: maxX + LAYOUT_FRAME_GAP, y: minY }
}

/** The topmost live frame containing a scene point, if any. */
export function frameAtPoint(
  elements: readonly FrameSceneElement[],
  point: { x: number; y: number }
): string | null {
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]
    if (!isLiveFrame(element)) continue
    if (
      point.x >= element.x &&
      point.x <= element.x + element.width &&
      point.y >= element.y &&
      point.y <= element.y + element.height
    ) {
      return element.id
    }
  }
  return null
}

/**
 * The scene with `childIds` moved into `frameId`, keeping Excalidraw's frame
 * ordering invariant: a frame's children sit directly before the frame in the
 * elements array. The array is re-ordered, not re-indexed — Excalidraw repairs
 * fractional indices itself when the scene is replaced.
 */
export function placeInFrame<T extends FrameSceneElement>(
  elements: readonly T[],
  childIds: ReadonlySet<string>,
  frameId: string
): T[] {
  const children: T[] = []
  const rest: T[] = []
  for (const element of elements) {
    if (childIds.has(element.id)) {
      children.push(
        element.frameId === frameId ? element : bumpElement(element, { frameId } as Partial<T>)
      )
    } else rest.push(element)
  }
  const frameIndex = rest.findIndex((element) => element.id === frameId)
  if (frameIndex === -1) return [...rest, ...children]
  return [...rest.slice(0, frameIndex), ...children, ...rest.slice(frameIndex)]
}
