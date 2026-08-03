/**
 * Agent-facing summary of a canvas scene.
 *
 * A serialized Excalidraw scene is mostly geometry, style props and version
 * counters — dumping it into an agent's context is large and almost entirely
 * noise. What an agent actually wants is "which notes/tasks/events live on this
 * canvas" plus whatever the user typed on it. This produces exactly that, and
 * never the raw scene.
 *
 * Excalidraw-free (plain JSON parsing) so it runs in main and unit-tests
 * without the library, mirroring the card contract in scene-refs.ts: a card is
 * a `rectangle` carrying `customData: { entityType, entityId }`.
 *
 * See docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §3.1.
 *
 * @module canvas/summary
 */

import { CANVAS_ENTITY_TYPES, type CanvasEntityRef } from '@memry/contracts/canvas-api'

/** Most text elements returned for one canvas. */
export const MAX_SUMMARY_TEXTS = 200
/** Most text characters returned for one canvas, summed across elements. */
export const MAX_SUMMARY_TEXT_CHARS = 20_000

export interface CanvasSceneSummary {
  items: CanvasEntityRef[]
  texts: string[]
  /** Live (non-deleted) elements in the scene. */
  elementCount: number
  /** True when either cap stopped text collection. */
  textsTruncated: boolean
}

interface SceneElementLike {
  type?: unknown
  isDeleted?: unknown
  customData?: unknown
  text?: unknown
}

function emptySummary(): CanvasSceneSummary {
  return { items: [], texts: [], elementCount: 0, textsTruncated: false }
}

function isEntityType(value: unknown): value is CanvasEntityRef['entityType'] {
  return typeof value === 'string' && (CANVAS_ENTITY_TYPES as readonly string[]).includes(value)
}

function cardRef(element: SceneElementLike): CanvasEntityRef | null {
  if (element.type !== 'rectangle') return null
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
 * Parse a serialized scene into the agent-facing summary. An empty string or an
 * unparseable scene yields an empty summary rather than throwing, matching
 * extractEntityRefsFromScene — a corrupt scene must never break a read.
 */
export function summarizeScene(scene: string): CanvasSceneSummary {
  if (!scene) return emptySummary()

  let elements: unknown
  try {
    const parsed = JSON.parse(scene) as { elements?: unknown }
    elements = parsed.elements
  } catch {
    return emptySummary()
  }
  if (!Array.isArray(elements)) return emptySummary()

  const seen = new Set<string>()
  const items: CanvasEntityRef[] = []
  const texts: string[] = []
  let elementCount = 0
  let textChars = 0
  let textsTruncated = false

  for (const element of elements as SceneElementLike[]) {
    if (element.isDeleted === true) continue
    elementCount++

    const ref = cardRef(element)
    if (ref) {
      const key = `${ref.entityType}:${ref.entityId}`
      if (!seen.has(key)) {
        seen.add(key)
        items.push(ref)
      }
      continue
    }

    if (element.type !== 'text' || typeof element.text !== 'string') continue
    const text = element.text.trim()
    if (!text) continue
    if (texts.length >= MAX_SUMMARY_TEXTS || textChars + text.length > MAX_SUMMARY_TEXT_CHARS) {
      textsTruncated = true
      continue
    }
    texts.push(text)
    textChars += text.length
  }

  return { items, texts, elementCount, textsTruncated }
}
