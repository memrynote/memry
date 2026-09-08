import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasWebGLSupport } from './webgl-support'

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
