/**
 * Write to a canvas from outside its editor: the live instance when this
 * window has it mounted, a guarded read-modify-write of the stored scene when
 * nobody does.
 *
 * Shared by the agent MCP write responder and by UI that adds cards from
 * elsewhere in the app (the note page's "Add to canvas"). Both need the same
 * two guarantees: an open editor is written through, so its next autosave
 * cannot overwrite the change, and a headless write is rejected if the canvas
 * changed after it was read.
 *
 * @module pages/canvas/canvas-write
 */

import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import type { AgentMcpCanvasWriteSkip } from '@memry/contracts/agent-mcp-channels'
import type { CanvasFontFamily } from '@memry/contracts/canvas-draw'

import { cardDefaultSize, entityKey, extractEntityRefs, getCardRefs } from './canvas-cards'
import type { DrawPlanOptions } from './canvas-draw-plan'
import { getLiveCanvas } from './canvas-live-registry'
import { planCardPlacements, type SceneEditElement } from './canvas-scene-edit'

export interface CanvasMutation {
  elements: SceneEditElement[]
  applied: CanvasEntityRef[]
  skipped: AgentMcpCanvasWriteSkip[]
  /** True when the op changed nothing, so the canvas must not be touched. */
  noop?: boolean
}

export interface CanvasWriteResult<M extends CanvasMutation> {
  mutation: M
  updatedAt: number
  tooLarge: boolean
  path: 'live' | 'headless'
}

/**
 * A note card is measured from its body (mirrors the picker/drop paths); every
 * other type takes the compact card. A failed lookup falls back to the compact
 * size rather than failing the write — the card is one drag from right.
 */
async function sizeFor(ref: CanvasEntityRef): Promise<{ width: number; height: number }> {
  if (ref.entityType !== 'note') return cardDefaultSize(ref.entityType)
  try {
    const note = await window.api.notes.get(ref.entityId)
    return cardDefaultSize('note', note?.content ?? '')
  } catch {
    return cardDefaultSize('note')
  }
}

/** Cards for `items` placed clear of what is on the scene; ones already carded are skipped. */
export async function applyAdd(
  elements: readonly SceneEditElement[],
  items: readonly CanvasEntityRef[]
): Promise<CanvasMutation> {
  const present = new Set(getCardRefs(elements).map((c) => entityKey(c.entityType, c.entityId)))
  const skipped: AgentMcpCanvasWriteSkip[] = []
  const applied: CanvasEntityRef[] = []

  for (const ref of items) {
    const key = entityKey(ref.entityType, ref.entityId)
    if (present.has(key)) {
      skipped.push({ ref, reason: 'already-on-canvas' })
      continue
    }
    present.add(key)
    applied.push(ref)
  }
  if (applied.length === 0) return { elements: [...elements], applied, skipped }

  const sized = await Promise.all(applied.map(async (ref) => ({ ...ref, ...(await sizeFor(ref)) })))
  const skeletons = planCardPlacements(elements, sized)
  // Dynamic import on purpose: CanvasEditor is a lazy chunk so
  // @excalidraw/excalidraw stays out of the main renderer bundle, and this
  // module is reachable from always-mounted code.
  const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
  const created = convertToExcalidrawElements(
    skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
  ) as unknown as SceneEditElement[]

  return { elements: [...elements, ...created], applied, skipped }
}

async function readStoredScene(
  canvasId: string
): Promise<{ updatedAt: number; scene: Record<string, unknown>; elements: SceneEditElement[] }> {
  const canvas = await window.api.canvas.get(canvasId)
  if (!canvas) throw new Error(`Canvas ${canvasId} not found`)
  const scene = canvas.scene
    ? (JSON.parse(canvas.scene) as Record<string, unknown> & { elements?: SceneEditElement[] })
    : {}
  return { updatedAt: canvas.updatedAt, scene, elements: scene.elements ?? [] }
}

/**
 * Compute a mutation against the canvas as it is now and persist it.
 *
 * Re-checks for a live editor at call time rather than trusting a caller's
 * routing: a canvas that unmounted while the write was in flight falls through
 * to the headless path instead of touching a torn-down editor.
 */
export async function writeCanvas<M extends CanvasMutation>(
  canvasId: string,
  compute: (elements: readonly SceneEditElement[]) => Promise<M> | M
): Promise<CanvasWriteResult<M>> {
  const live = getLiveCanvas(canvasId)
  const stored = live ? null : await readStoredScene(canvasId)
  const source = live ? live.getElements() : (stored?.elements ?? [])

  const mutation = await compute(source)

  let updatedAt = stored?.updatedAt ?? 0
  let tooLarge = false

  if (mutation.noop ?? mutation.applied.length === 0) {
    // Nothing changed — never touch the canvas or bump updatedAt.
  } else if (live) {
    live.updateScene(mutation.elements)
    await live.flush()
    updatedAt = Date.now()
  } else if (stored) {
    // expectedUpdatedAt MUST come from the same read `mutation.elements` was
    // computed from. Re-reading here to get a "fresher" value is what defeats
    // the guard: the check would pass against a row that changed after we read
    // it, and this write would then silently discard that change. Guarding on
    // the original read means anything that landed in between is rejected,
    // which is the entire point.
    const result = await window.api.canvas.update({
      id: canvasId,
      scene: JSON.stringify({ ...stored.scene, elements: mutation.elements }),
      // Never trust the caller's view of what is on the canvas.
      entityRefs: extractEntityRefs(mutation.elements),
      expectedUpdatedAt: stored.updatedAt
    })
    updatedAt = result.updatedAt
    tooLarge = result.tooLarge
  }

  return { mutation, updatedAt, tooLarge, path: live ? 'live' : 'headless' }
}

/**
 * Excalidraw's font registry is numeric and has been renumbered before, so the
 * named→number mapping is read off the live constant rather than hardcoded.
 * These four are what the editor's own font picker offers.
 */
const FONT_KEYS: Record<CanvasFontFamily, string> = {
  'hand-drawn': 'Excalifont',
  normal: 'Nunito',
  code: 'Comic Shanns',
  lilita: 'Lilita One'
}

export async function drawOptions(): Promise<DrawPlanOptions> {
  const { FONT_FAMILY, ROUNDNESS } = await import('@excalidraw/excalidraw')
  const fonts = FONT_FAMILY as unknown as Record<string, number | undefined>
  const fallback = fonts.Nunito ?? 2
  return {
    fontFamily: {
      'hand-drawn': fonts[FONT_KEYS['hand-drawn']] ?? fallback,
      normal: fonts[FONT_KEYS.normal] ?? fallback,
      code: fonts[FONT_KEYS.code] ?? fallback,
      lilita: fonts[FONT_KEYS.lilita] ?? fallback
    },
    adaptiveRadius: (ROUNDNESS as unknown as { ADAPTIVE_RADIUS?: number }).ADAPTIVE_RADIUS ?? 3,
    // Excalidraw ids are opaque strings; uniqueness is the only requirement,
    // and minting them here (rather than letting convertToExcalidrawElements
    // regenerate) is what lets the plan wire bindings and return a ref map.
    newId: () => crypto.randomUUID()
  }
}

/** Card each item on `canvasId`; items already on it are reported as skipped. */
export function addItemsToCanvas(
  canvasId: string,
  items: readonly CanvasEntityRef[]
): Promise<CanvasWriteResult<CanvasMutation>> {
  return writeCanvas(canvasId, (elements) => applyAdd(elements, items))
}
