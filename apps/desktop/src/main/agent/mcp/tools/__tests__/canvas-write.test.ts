import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mainToRendererInvoke: vi.fn(),
  fromId: vi.fn(),
  getAllWindows: vi.fn(),
  getCanvasWindowId: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: mocks.fromId, getAllWindows: mocks.getAllWindows }
}))
vi.mock('../../../../lib/window-rpc', () => ({
  mainToRendererInvoke: mocks.mainToRendererInvoke
}))
vi.mock('../../../../canvas/live-registry', () => ({
  getCanvasWindowId: mocks.getCanvasWindowId
}))

const win = (id: number) => ({ id, isDestroyed: () => false })
const okResponse = {
  ok: true,
  applied: [],
  skipped: [],
  updatedAt: 1,
  tooLarge: false,
  path: 'live'
}
const request = { canvasId: 'c1', op: 'add' as const, items: [] }

describe('invokeCanvasWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mainToRendererInvoke.mockResolvedValue(okResponse)
  })

  it('prefers the window that has the canvas open', async () => {
    mocks.getCanvasWindowId.mockReturnValue(7)
    mocks.fromId.mockImplementation((id: number) => (id === 7 ? win(7) : null))
    const { invokeCanvasWrite } = await import('../canvas-write')

    await invokeCanvasWrite('3', request)

    expect(mocks.mainToRendererInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      expect.any(String),
      expect.objectContaining({ canvasId: 'c1' }),
      expect.any(Object)
    )
  })

  it('falls back to the calling window when the registry entry is stale', async () => {
    mocks.getCanvasWindowId.mockReturnValue(7)
    mocks.fromId.mockImplementation((id: number) => (id === 3 ? win(3) : null))
    mocks.getAllWindows.mockReturnValue([win(3)])
    const { invokeCanvasWrite } = await import('../canvas-write')

    await invokeCanvasWrite('3', request)

    expect(mocks.mainToRendererInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3 }),
      expect.any(String),
      expect.anything(),
      expect.any(Object)
    )
  })

  it('falls back to any live window when there is no caller window', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.fromId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([win(9)])
    const { invokeCanvasWrite } = await import('../canvas-write')

    await invokeCanvasWrite(null, request)

    expect(mocks.mainToRendererInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9 }),
      expect.any(String),
      expect.anything(),
      expect.any(Object)
    )
  })

  it('throws when no window can mint elements', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.fromId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([])
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, request)).rejects.toThrow(/window/i)
  })

  it('surfaces a renderer error as a tool error', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.fromId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([win(1)])
    mocks.mainToRendererInvoke.mockResolvedValue({
      ok: false,
      error: { code: 'CANVAS_WRITE_ERROR', message: 'Canvas was modified by someone else' }
    })
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, request)).rejects.toThrow(/modified/i)
  })

  it('throws when the renderer never answers', async () => {
    mocks.getCanvasWindowId.mockReturnValue(null)
    mocks.fromId.mockReturnValue(null)
    mocks.getAllWindows.mockReturnValue([win(1)])
    mocks.mainToRendererInvoke.mockResolvedValue(null)
    const { invokeCanvasWrite } = await import('../canvas-write')

    await expect(invokeCanvasWrite(null, request)).rejects.toThrow(/timed out|no result/i)
  })
})
