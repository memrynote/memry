import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentToolError } from '../../errors'

const mocks = vi.hoisted(() => ({ getFeaturesSettings: vi.fn() }))
vi.mock('../../../../settings/features', () => ({
  getFeaturesSettings: mocks.getFeaturesSettings
}))

describe('assertSpatialCanvasEnabled', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes when the flag is on', async () => {
    mocks.getFeaturesSettings.mockReturnValue({ spatialCanvas: true })
    const { assertSpatialCanvasEnabled } = await import('../canvas-flag')

    expect(() => assertSpatialCanvasEnabled()).not.toThrow()
  })

  it('throws an actionable PERMISSION_DENIED when the flag is off', async () => {
    mocks.getFeaturesSettings.mockReturnValue({ spatialCanvas: false })
    const { assertSpatialCanvasEnabled } = await import('../canvas-flag')

    try {
      assertSpatialCanvasEnabled()
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolError)
      expect((error as AgentToolError).code).toBe('PERMISSION_DENIED')
      expect((error as AgentToolError).message).toMatch(/Settings → Features/)
    }
  })

  it('treats a canvas.* operation as gated and anything else as not', async () => {
    const { isCanvasOperation } = await import('../canvas-flag')

    expect(isCanvasOperation('canvas.list')).toBe(true)
    expect(isCanvasOperation('canvas.create')).toBe(true)
    expect(isCanvasOperation('notes.get')).toBe(false)
  })
})
