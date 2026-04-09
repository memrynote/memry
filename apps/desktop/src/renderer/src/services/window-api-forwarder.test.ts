import { describe, expect, it, vi } from 'vitest'
import { createWindowApiForwarder } from './window-api-forwarder'

interface TestApi {
  greet(name: string): string
  count(): number
}

describe('createWindowApiForwarder', () => {
  it('forwards method calls to the underlying API', () => {
    const api: TestApi = { greet: vi.fn((n: string) => `hi ${n}`), count: vi.fn(() => 42) }
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect(proxy.greet('Kaan')).toBe('hi Kaan')
    expect(api.greet).toHaveBeenCalledWith('Kaan')
    expect(proxy.count()).toBe(42)
  })

  it('resolves lazily — follows selectApi changes', () => {
    let current: TestApi = { greet: vi.fn(() => 'a'), count: vi.fn(() => 1) }
    const proxy = createWindowApiForwarder<TestApi>(() => current)

    expect(proxy.count()).toBe(1)

    current = { greet: vi.fn(() => 'b'), count: vi.fn(() => 99) }
    expect(proxy.count()).toBe(99)
    expect(current.count).toHaveBeenCalled()
  })
})
