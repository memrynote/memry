import { describe, expect, it } from 'vitest'
import {
  getLiveCanvas,
  registerLiveCanvas,
  unregisterLiveCanvas,
  type LiveCanvasHandle
} from './canvas-live-registry'

const makeHandle = (): LiveCanvasHandle => ({
  getElements: () => [],
  updateScene: () => {},
  flush: async () => {}
})

describe('renderer live canvas registry', () => {
  it('returns a registered handle and null after unregister', () => {
    const handle = makeHandle()
    registerLiveCanvas('c1', handle)
    expect(getLiveCanvas('c1')).toBe(handle)

    unregisterLiveCanvas('c1')
    expect(getLiveCanvas('c1')).toBeNull()
  })

  it('unregister by a stale owner does not clear a newer handle', () => {
    const first = makeHandle()
    const second = makeHandle()
    registerLiveCanvas('c2', first)
    registerLiveCanvas('c2', second)

    // StrictMode: the FIRST mount's cleanup runs after the second registered.
    unregisterLiveCanvas('c2', first)

    expect(getLiveCanvas('c2')).toBe(second)
    unregisterLiveCanvas('c2', second)
  })
})
