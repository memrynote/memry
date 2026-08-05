/**
 * Renderer side of agent canvas item writes (#916).
 *
 * Two paths, chosen per request:
 *  - LIVE — this window has the target canvas mounted: apply to the live
 *    Excalidraw instance and flush the persister. Nothing is clobbered, and the
 *    user watches the card appear.
 *  - HEADLESS — nobody has it open: read, mutate, write back with an
 *    expectedUpdatedAt guard the store checks inside its transaction.
 *
 * Element minting goes through convertToExcalidrawElements either way; it is
 * the only thing that correctly produces ids, seeds, version counters and
 * fractional indices.
 */

import { useEffect } from 'react'
import { getI18n } from 'react-i18next'
import {
  AgentMcpCanvasWriteChannel,
  AgentMcpCanvasWriteRequestSchema,
  type AgentMcpCanvasElementOutcome,
  type AgentMcpCanvasWriteRequest,
  type AgentMcpCanvasWriteResponse,
  type AgentMcpCanvasWriteSkip
} from '@memry/contracts/agent-mcp-channels'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import { MAX_SCENE_ELEMENTS, type CanvasFontFamily } from '@memry/contracts/canvas-draw'

import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  cardDefaultSize,
  entityKey,
  extractEntityRefs,
  getCardRefs
} from '@/pages/canvas/canvas-cards'
import { getLiveCanvas } from '@/pages/canvas/canvas-live-registry'
import {
  applyDrawPlan,
  applyElementEdits,
  planDraw,
  type DrawPlanOptions
} from '@/pages/canvas/canvas-draw-plan'
import {
  planCardPlacements,
  removeCardElements,
  type SceneEditElement
} from '@/pages/canvas/canvas-scene-edit'

const log = createLogger('AgentMcpCanvasWrite')

interface Mutation {
  elements: SceneEditElement[]
  applied: CanvasEntityRef[]
  skipped: AgentMcpCanvasWriteSkip[]
  /** Present for the draw/edit ops; the card ops report through applied/skipped. */
  outcome?: AgentMcpCanvasElementOutcome
  /** True when the op changed nothing, so the canvas must not be touched. */
  noop?: boolean
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

async function applyAdd(
  elements: readonly SceneEditElement[],
  items: CanvasEntityRef[]
): Promise<Mutation> {
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
  // responder is always mounted.
  const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
  const created = convertToExcalidrawElements(
    skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
  ) as unknown as SceneEditElement[]

  return { elements: [...elements, ...created], applied, skipped }
}

function applyRemove(elements: readonly SceneEditElement[], items: CanvasEntityRef[]): Mutation {
  let next = [...elements]
  const applied: CanvasEntityRef[] = []
  const skipped: AgentMcpCanvasWriteSkip[] = []

  for (const ref of items) {
    const result = removeCardElements(next, ref)
    if (result.removedIds.length === 0) {
      skipped.push({ ref, reason: 'not-on-canvas' })
      continue
    }
    next = result.elements
    applied.push(ref)
  }
  return { elements: next, applied, skipped }
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

async function drawOptions(): Promise<DrawPlanOptions> {
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

async function applyDraw(
  elements: readonly SceneEditElement[],
  specs: Extract<AgentMcpCanvasWriteRequest, { op: 'draw' }>['elements']
): Promise<Mutation> {
  const options = await drawOptions()
  const plan = planDraw(elements, specs, options)
  if (elements.length + plan.skeletons.length > MAX_SCENE_ELEMENTS) {
    throw new Error(
      `Canvas would exceed ${MAX_SCENE_ELEMENTS} elements; delete some before drawing more.`
    )
  }

  const { convertToExcalidrawElements } = await import('@excalidraw/excalidraw')
  const created = convertToExcalidrawElements(
    plan.skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds: false }
  ) as unknown as SceneEditElement[]

  // The whole binding plan is keyed on ids minted before conversion, which
  // holds only while `regenerateIds: false` is honoured upstream. If that ever
  // changes the shapes still land but arrows come out unbound — a quiet
  // degradation, so say it out loud rather than let it look like a layout bug.
  const mintedIds = new Set(created.map((element) => element.id))
  const lost = plan.skeletons.filter((skeleton) => !mintedIds.has(skeleton.id as string))
  if (lost.length > 0) {
    log.warn('Excalidraw regenerated element ids; arrow bindings and frames were skipped', {
      lost: lost.length
    })
  }

  return {
    elements: applyDrawPlan(elements, created, plan),
    applied: [],
    skipped: [],
    outcome: {
      refs: plan.refs,
      createdIds: created.map((element) => element.id),
      updatedIds: [],
      deletedIds: [],
      missingIds: plan.missingIds
    },
    noop: created.length === 0
  }
}

async function applyEdit(
  elements: readonly SceneEditElement[],
  edits: Extract<AgentMcpCanvasWriteRequest, { op: 'edit' }>['edits']
): Promise<Mutation> {
  const result = applyElementEdits(elements, edits, await drawOptions())
  return {
    elements: result.elements,
    applied: [],
    skipped: [],
    outcome: {
      refs: {},
      createdIds: [],
      updatedIds: result.updatedIds,
      deletedIds: result.deletedIds,
      missingIds: result.missingIds
    },
    noop: result.updatedIds.length === 0 && result.deletedIds.length === 0
  }
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

export function useAgentMcpCanvasWriteResponder({
  enabled = true
}: { enabled?: boolean } = {}): void {
  useEffect(() => {
    if (!enabled) return

    return window.api.onMainInvoke(async ({ requestId, channel, payload }) => {
      if (channel !== AgentMcpCanvasWriteChannel) return

      const parsed = AgentMcpCanvasWriteRequestSchema.safeParse(payload)
      if (!parsed.success) {
        window.api.respondToMainInvoke(requestId, {
          ok: false,
          error: { code: 'VALIDATION', message: 'Invalid canvas write request.' }
        } satisfies AgentMcpCanvasWriteResponse)
        return
      }

      const request = parsed.data
      const { canvasId } = request
      try {
        // Re-checked here rather than trusting main's routing: a canvas that
        // unmounted while the write was in flight falls through to the headless
        // path instead of touching a torn-down editor.
        const live = getLiveCanvas(canvasId)
        const stored = live ? null : await readStoredScene(canvasId)
        const source = live ? live.getElements() : (stored?.elements ?? [])

        let mutation: Mutation
        if (request.op === 'add') mutation = await applyAdd(source, request.items)
        else if (request.op === 'remove') mutation = applyRemove(source, request.items)
        else if (request.op === 'draw') mutation = await applyDraw(source, request.elements)
        else mutation = await applyEdit(source, request.edits)

        let updatedAt = stored?.updatedAt ?? 0
        let tooLarge = false

        if (mutation.noop ?? mutation.applied.length === 0) {
          // Nothing changed — never touch the canvas or bump updatedAt.
        } else if (live) {
          live.updateScene(mutation.elements)
          await live.flush()
          updatedAt = Date.now()
        } else if (stored) {
          // expectedUpdatedAt MUST come from the same read `mutation.elements`
          // was computed from. Re-reading here to get a "fresher" value is what
          // defeats the guard: the check would pass against a row that changed
          // after we read it, and this write would then silently discard that
          // change. Guarding on the original read means anything that landed in
          // between is rejected, which is the entire point.
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

        window.api.respondToMainInvoke(requestId, {
          ok: true,
          applied: mutation.applied,
          skipped: mutation.skipped,
          updatedAt,
          tooLarge,
          path: live ? 'live' : 'headless',
          ...(mutation.outcome ? { elements: mutation.outcome } : {})
        } satisfies AgentMcpCanvasWriteResponse)
      } catch (error) {
        log.error('Canvas write failed', error)
        window.api.respondToMainInvoke(requestId, {
          ok: false,
          error: {
            code: 'CANVAS_WRITE_ERROR',
            message: extractErrorMessage(
              error,
              getI18n().getFixedT(null, 'errors')('generic.operationFailed')
            )
          }
        } satisfies AgentMcpCanvasWriteResponse)
      }
    })
  }, [enabled])
}
