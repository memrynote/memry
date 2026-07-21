import { beforeEach, describe, expect, it, vi } from 'vitest'

const { localMutationsMock, trackMainEventMock } = vi.hoisted(() => ({
  localMutationsMock: {
    enqueueLocalSyncCreate: vi.fn(),
    enqueueLocalSyncUpdate: vi.fn(),
    enqueueLocalSyncDelete: vi.fn(),
    bumpCanvasClockLocalOnly: vi.fn()
  },
  trackMainEventMock: vi.fn()
}))

vi.mock('../sync/local-mutations', () => localMutationsMock)
vi.mock('../telemetry/track', () => ({ trackMainEvent: trackMainEventMock }))

import {
  CANVAS_SCENE_SYNC_CAP_BYTES,
  canvasSceneExceedsSyncCap,
  syncCanvasCreate,
  syncCanvasUpdate
} from './sync-bridge'

const SMALL_SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })

/** A freehand-ink-like scene: many points in one stroke, no images — pure JSON growth. */
function hugeFreehandScene(): string {
  const points: [number, number][] = []
  for (let i = 0; i < 400_000; i++) {
    points.push([i, i])
  }
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [{ id: 'ink1', type: 'freedraw', points }]
  })
}

describe('canvasSceneExceedsSyncCap', () => {
  it('returns false for a small scene', () => {
    expect(canvasSceneExceedsSyncCap(SMALL_SCENE)).toBe(false)
  })

  it('returns true once UTF-8 byte length exceeds the cap', () => {
    const scene = hugeFreehandScene()
    expect(Buffer.byteLength(scene, 'utf8')).toBeGreaterThan(CANVAS_SCENE_SYNC_CAP_BYTES)
    expect(canvasSceneExceedsSyncCap(scene)).toBe(true)
  })

  it('stays under cap for a moderate scene with externalized memry-file:// image refs (M5)', () => {
    // Post-M5, images are stored on disk and referenced by URL instead of inlined as
    // base64 — externalization is what keeps normal scenes under the cap.
    const refs = Array.from(
      { length: 50 },
      (_, i) => `memry-file://vault-1/canvas-assets/image-${i}.png`
    )
    const scene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: refs.map((url, i) => ({ id: `img${i}`, type: 'image', fileUrl: url }))
    })
    expect(Buffer.byteLength(scene, 'utf8')).toBeLessThan(CANVAS_SCENE_SYNC_CAP_BYTES)
    expect(canvasSceneExceedsSyncCap(scene)).toBe(false)
  })
})

describe('syncCanvasUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('too-large scene: returns false, emits canvas_too_large telemetry, bumps clock locally, does not enqueue', () => {
    const scene = hugeFreehandScene()
    const byteCount = Buffer.byteLength(scene, 'utf8')

    const result = syncCanvasUpdate('canvas-1', scene)

    expect(result).toBe(false)
    expect(trackMainEventMock).toHaveBeenCalledWith('canvas_too_large', {
      surface: 'sync',
      action: 'push_blocked',
      objectType: 'canvas',
      result: 'skipped',
      metrics: { byteCount }
    })
    // Local-only clock bump (not a silent markFailed): a later remote edit resolves
    // as concurrent instead of clobbering the retained-but-unsynced scene.
    expect(localMutationsMock.bumpCanvasClockLocalOnly).toHaveBeenCalledWith('canvas-1')
    expect(localMutationsMock.enqueueLocalSyncUpdate).not.toHaveBeenCalled()
  })

  it('small scene: returns true, enqueues update, does not emit telemetry', () => {
    const result = syncCanvasUpdate('canvas-1', SMALL_SCENE)

    expect(result).toBe(true)
    expect(localMutationsMock.enqueueLocalSyncUpdate).toHaveBeenCalledWith('canvas', 'canvas-1')
    expect(trackMainEventMock).not.toHaveBeenCalled()
    expect(localMutationsMock.bumpCanvasClockLocalOnly).not.toHaveBeenCalled()
  })
})

describe('syncCanvasCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('too-large initial scene: returns false, emits canvas_too_large telemetry, does not enqueue', () => {
    const scene = hugeFreehandScene()
    const byteCount = Buffer.byteLength(scene, 'utf8')

    const result = syncCanvasCreate('canvas-2', scene)

    expect(result).toBe(false)
    expect(trackMainEventMock).toHaveBeenCalledWith('canvas_too_large', {
      surface: 'sync',
      action: 'push_blocked',
      objectType: 'canvas',
      result: 'skipped',
      metrics: { byteCount }
    })
    expect(localMutationsMock.enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })

  it('small scene: returns true, enqueues create', () => {
    const result = syncCanvasCreate('canvas-2', SMALL_SCENE)

    expect(result).toBe(true)
    expect(localMutationsMock.enqueueLocalSyncCreate).toHaveBeenCalledWith('canvas', 'canvas-2')
    expect(trackMainEventMock).not.toHaveBeenCalled()
  })
})
