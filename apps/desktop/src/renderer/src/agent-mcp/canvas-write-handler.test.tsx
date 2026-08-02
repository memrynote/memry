import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMcpCanvasWriteChannel } from '@memry/contracts/agent-mcp-channels'

const mocks = vi.hoisted(() => ({ logError: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

// The real package is a lazy chunk loaded only by CanvasEditor; the handler
// imports it dynamically. Stub it so jsdom never pulls the Excalidraw bundle —
// element-field correctness is proven separately against the REAL converter in
// canvas-scene-roundtrip.test.ts.
vi.mock('@excalidraw/excalidraw', () => ({
  convertToExcalidrawElements: (skeletons: { customData: unknown }[]) =>
    skeletons.map((skeleton, index) => ({
      id: `new-${index}`,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 260,
      height: 168,
      angle: 0,
      customData: skeleton.customData
    }))
}))

import {
  getLiveCanvas,
  registerLiveCanvas,
  unregisterLiveCanvas
} from '@/pages/canvas/canvas-live-registry'
import { useAgentMcpCanvasWriteResponder } from './canvas-write-handler'

type Invoke = (payload: {
  requestId: string
  channel: string
  payload?: unknown
}) => void | Promise<void>

describe('useAgentMcpCanvasWriteResponder', () => {
  let onMainInvokeCallback: Invoke | undefined
  let respondToMainInvoke: ReturnType<typeof vi.fn>
  let canvasGet: ReturnType<typeof vi.fn>
  let canvasUpdate: ReturnType<typeof vi.fn>
  let notesGet: ReturnType<typeof vi.fn>

  const cardElement = (entityId: string, id = `rect-${entityId}`) => ({
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 260,
    height: 168,
    angle: 0,
    customData: { entityType: 'note', entityId }
  })

  beforeEach(() => {
    onMainInvokeCallback = undefined
    respondToMainInvoke = vi.fn()
    canvasGet = vi.fn()
    canvasUpdate = vi.fn()
    notesGet = vi.fn().mockResolvedValue({ id: 'n1', content: 'hello' })
    mocks.logError.mockReset()
    unregisterLiveCanvas('c1')
    ;(window as Window & { api: unknown }).api = {
      onMainInvoke: vi.fn((callback: Invoke) => {
        onMainInvokeCallback = callback
        return vi.fn()
      }),
      respondToMainInvoke,
      canvas: { get: canvasGet, update: canvasUpdate },
      notes: { get: notesGet }
    }
  })

  async function send(payload: unknown): Promise<unknown> {
    renderHook(() => useAgentMcpCanvasWriteResponder())
    await waitFor(() => expect(window.api.onMainInvoke).toHaveBeenCalled())
    await onMainInvokeCallback?.({
      requestId: 'r1',
      channel: AgentMcpCanvasWriteChannel,
      payload
    })
    return respondToMainInvoke.mock.calls.at(-1)?.[1]
  }

  it('applies to the live editor when this window has the canvas open', async () => {
    const updateScene = vi.fn()
    const flush = vi.fn(async () => {})
    registerLiveCanvas('c1', { getElements: () => [], updateScene, flush })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(updateScene).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(canvasUpdate).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, path: 'live' })
    unregisterLiveCanvas('c1')
  })

  it('falls back to the headless path with an optimistic guard', async () => {
    canvasGet.mockResolvedValue({
      id: 'c1',
      title: null,
      createdAt: 1,
      updatedAt: 42,
      scene: JSON.stringify({ type: 'excalidraw', elements: [] })
    })
    canvasUpdate.mockResolvedValue({ id: 'c1', updatedAt: 43, tooLarge: false })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(canvasUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', expectedUpdatedAt: 42 })
    )
    expect(result).toMatchObject({ ok: true, path: 'headless', updatedAt: 43 })
  })

  it('re-derives entityRefs from the mutated scene rather than the request', async () => {
    canvasGet.mockResolvedValue({
      id: 'c1',
      updatedAt: 1,
      scene: JSON.stringify({ type: 'excalidraw', elements: [] })
    })
    canvasUpdate.mockResolvedValue({ id: 'c1', updatedAt: 2, tooLarge: false })

    await send({ canvasId: 'c1', op: 'add', items: [{ entityType: 'note', entityId: 'n1' }] })

    const [arg] = canvasUpdate.mock.calls[0]
    expect(arg.entityRefs).toEqual([{ entityType: 'note', entityId: 'n1' }])
  })

  it('surfaces tooLarge from the update response', async () => {
    canvasGet.mockResolvedValue({
      id: 'c1',
      updatedAt: 1,
      scene: JSON.stringify({ type: 'excalidraw', elements: [] })
    })
    canvasUpdate.mockResolvedValue({ id: 'c1', updatedAt: 2, tooLarge: true })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(result).toMatchObject({ ok: true, tooLarge: true })
  })

  it('skips an entity already on the canvas instead of duplicating it', async () => {
    const updateScene = vi.fn()
    registerLiveCanvas('c1', {
      getElements: () => [cardElement('n1')] as never,
      updateScene,
      flush: vi.fn(async () => {})
    })

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(updateScene).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      applied: [],
      skipped: [{ ref: { entityType: 'note', entityId: 'n1' }, reason: 'already-on-canvas' }]
    })
    unregisterLiveCanvas('c1')
  })

  it('removes a card from the live editor and reports it applied', async () => {
    const updateScene = vi.fn()
    registerLiveCanvas('c1', {
      getElements: () => [cardElement('n1'), cardElement('n2')] as never,
      updateScene,
      flush: vi.fn(async () => {})
    })

    const result = await send({
      canvasId: 'c1',
      op: 'remove',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(updateScene).toHaveBeenCalledOnce()
    expect(updateScene.mock.calls[0][0].map((e: { id: string }) => e.id)).toEqual(['rect-n2'])
    expect(result).toMatchObject({ ok: true, applied: [{ entityId: 'n1' }] })
    unregisterLiveCanvas('c1')
  })

  it('reports not-on-canvas when removing an absent entity', async () => {
    registerLiveCanvas('c1', {
      getElements: () => [],
      updateScene: vi.fn(),
      flush: vi.fn(async () => {})
    })

    const result = await send({
      canvasId: 'c1',
      op: 'remove',
      items: [{ entityType: 'note', entityId: 'ghost' }]
    })

    expect(result).toMatchObject({
      ok: true,
      applied: [],
      skipped: [{ reason: 'not-on-canvas' }]
    })
    unregisterLiveCanvas('c1')
  })

  it('rejects a malformed request', async () => {
    const result = await send({ canvasId: '', op: 'add', items: [] })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  })

  it('reports a failed canvas read as an error response', async () => {
    canvasGet.mockResolvedValue(null)

    const result = await send({
      canvasId: 'c1',
      op: 'add',
      items: [{ entityType: 'note', entityId: 'n1' }]
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'CANVAS_WRITE_ERROR' } })
    expect(getLiveCanvas('c1')).toBeNull()
  })
})
