import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasWebGLSupport } from './webgl-support'

const mocks = vi.hoisted(() => ({ trackRendererLog: vi.fn() }))

vi.mock('./telemetry-diagnostics', () => ({ trackRendererLog: mocks.trackRendererLog }))

describe('hasWebGLSupport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports false when the browser cannot create any supported context', () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    expect(hasWebGLSupport()).toBe(false)
    expect(getContext.mock.calls.map(([kind]) => kind)).toEqual([
      'webgl2',
      'webgl',
      'experimental-webgl'
    ])
  })

  it('releases the probe context after confirming support', () => {
    const loseContext = vi.fn()
    const getExtension = vi.fn(() => ({ loseContext }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension
    } as unknown as RenderingContext)

    expect(hasWebGLSupport()).toBe(true)
    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context')
    expect(loseContext).toHaveBeenCalledOnce()
  })

  it('reports false when context creation throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('WebGL disabled')
    })

    expect(hasWebGLSupport()).toBe(false)
  })
})

describe('hasWebGLSupport telemetry', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.trackRendererLog.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports an unavailable WebGL context once per session', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { hasWebGLSupport: probe } = await import('./webgl-support')

    expect(probe()).toBe(false)
    expect(probe()).toBe(false)
    expect(mocks.trackRendererLog).toHaveBeenCalledTimes(1)
    expect(mocks.trackRendererLog).toHaveBeenCalledWith('warn', 'webgl_unavailable', 'WebGLSupport')
  })

  it('stays silent when WebGL works', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: () => null
    } as unknown as RenderingContext)
    const { hasWebGLSupport: probe } = await import('./webgl-support')

    expect(probe()).toBe(true)
    expect(mocks.trackRendererLog).not.toHaveBeenCalled()
  })
})
