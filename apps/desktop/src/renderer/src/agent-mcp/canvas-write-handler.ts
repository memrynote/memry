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
import { MAX_SCENE_ELEMENTS } from '@memry/contracts/canvas-draw'

import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { applyDrawPlan, applyElementEdits, planDraw } from '@/pages/canvas/canvas-draw-plan'
import { removeCardElements, type SceneEditElement } from '@/pages/canvas/canvas-scene-edit'
import {
  applyAdd,
  drawOptions,
  writeCanvas,
  type CanvasMutation
} from '@/pages/canvas/canvas-write'

const log = createLogger('AgentMcpCanvasWrite')

interface Mutation extends CanvasMutation {
  /** Present for the draw/edit ops; the card ops report through applied/skipped. */
  outcome?: AgentMcpCanvasElementOutcome
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
        // `writeCanvas` re-checks for a live editor at call time rather than
        // trusting main's routing.
        const { mutation, updatedAt, tooLarge, path } = await writeCanvas<Mutation>(
          canvasId,
          (source) => {
            if (request.op === 'add') return applyAdd(source, request.items)
            if (request.op === 'remove') return applyRemove(source, request.items)
            if (request.op === 'draw') return applyDraw(source, request.elements)
            return applyEdit(source, request.edits)
          }
        )

        window.api.respondToMainInvoke(requestId, {
          ok: true,
          applied: mutation.applied,
          skipped: mutation.skipped,
          updatedAt,
          tooLarge,
          path,
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
