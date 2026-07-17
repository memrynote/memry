import { afterEach, describe, expect, it, vi } from 'vitest'

import { canvasService, onCanvasCreated, onCanvasUpdated, onCanvasDeleted } from './canvas-service'

type WindowWithApi = typeof window & { api: Record<string, unknown> }

const win = window as WindowWithApi
const originalApi = win.api

afterEach(() => {
  win.api = originalApi
})

describe('canvas-service', () => {
  it('forwards calls lazily to the current window.api.canvas', async () => {
    const get = vi.fn().mockResolvedValue(null)
    win.api = { ...originalApi, canvas: { get } }

    await expect(canvasService.get('c1')).resolves.toBeNull()
    expect(get).toHaveBeenCalledWith('c1')
  })

  it('wraps event subscriptions and returns their unsubscribe closures', () => {
    const unsubscribe = vi.fn()
    const created = vi.fn().mockReturnValue(unsubscribe)
    const updated = vi.fn().mockReturnValue(unsubscribe)
    const deleted = vi.fn().mockReturnValue(unsubscribe)
    win.api = {
      ...originalApi,
      onCanvasCreated: created,
      onCanvasUpdated: updated,
      onCanvasDeleted: deleted
    }

    const callback = vi.fn()
    expect(onCanvasCreated(callback)).toBe(unsubscribe)
    expect(onCanvasUpdated(callback)).toBe(unsubscribe)
    expect(onCanvasDeleted(callback)).toBe(unsubscribe)
    expect(created).toHaveBeenCalledWith(callback)
    expect(updated).toHaveBeenCalledWith(callback)
    expect(deleted).toHaveBeenCalledWith(callback)
  })
})
