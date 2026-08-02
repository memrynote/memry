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
  type AgentMcpCanvasWriteResponse,
  type AgentMcpCanvasWriteSkip
} from '@memry/contracts/agent-mcp-channels'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'

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
  planCardPlacements,
  removeCardElements,
  type SceneEditElement
} from '@/pages/canvas/canvas-scene-edit'

const log = createLogger('AgentMcpCanvasWrite')

interface Mutation {
  elements: SceneEditElement[]
  applied: CanvasEntityRef[]
  skipped: AgentMcpCanvasWriteSkip[]
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

      const { canvasId, op, items } = parsed.data
      try {
        // Re-checked here rather than trusting main's routing: a canvas that
        // unmounted while the write was in flight falls through to the headless
        // path instead of touching a torn-down editor.
        const live = getLiveCanvas(canvasId)
        const stored = live ? null : await readStoredScene(canvasId)
        const source = live ? live.getElements() : (stored?.elements ?? [])

        const mutation = op === 'add' ? await applyAdd(source, items) : applyRemove(source, items)

        let updatedAt = stored?.updatedAt ?? 0
        let tooLarge = false

        if (mutation.applied.length === 0) {
          // Nothing changed — never touch the canvas or bump updatedAt.
        } else if (live) {
          live.updateScene(mutation.elements)
          await live.flush()
          updatedAt = Date.now()
        } else {
          const fresh = await readStoredScene(canvasId)
          const result = await window.api.canvas.update({
            id: canvasId,
            scene: JSON.stringify({ ...fresh.scene, elements: mutation.elements }),
            // Never trust the caller's view of what is on the canvas.
            entityRefs: extractEntityRefs(mutation.elements),
            expectedUpdatedAt: fresh.updatedAt
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
          path: live ? 'live' : 'headless'
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
