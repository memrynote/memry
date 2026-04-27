import { describe, expect, it } from 'vitest'
import { createRendererOrigin, isRendererOrigin } from './origin-tags'

describe('origin tags', () => {
  it('keeps the renderer origin stable across calls', () => {
    const first = createRendererOrigin()
    const second = createRendererOrigin()

    expect(first).toBe(second)
    expect(first).not.toBe(0)
  })

  it('matches its own origin', () => {
    expect(isRendererOrigin(createRendererOrigin())).toBe(true)
  })

  it('rejects foreign origins', () => {
    expect(isRendererOrigin(0)).toBe(false)
    expect(isRendererOrigin(99)).toBe(false)
    expect(isRendererOrigin('99')).toBe(false)
  })
})
