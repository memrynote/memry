import { describe, expect, it, vi } from 'vitest'
import { createWindowApiForwarder } from './window-api-forwarder'

interface TestApi {
  greet(name: string): string
  count(): number
}

function createTestApi(): TestApi {
  return {
    greet: vi.fn((name: string) => `hi ${name}`),
    count: vi.fn(() => 42)
  }
}

describe('createWindowApiForwarder', () => {
  it('forwards method calls to the underlying API', () => {
    const api = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect(proxy.greet('Kaan')).toBe('hi Kaan')
    expect(api.greet).toHaveBeenCalledWith('Kaan')
    expect(proxy.count()).toBe(42)
  })

  it('returns the same function reference as the underlying API', () => {
    const api = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect(proxy.greet).toBe(api.greet)
    expect(proxy.count).toBe(api.count)
  })

  it('supports the "in" operator via has trap', () => {
    const api = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect('greet' in proxy).toBe(true)
    expect('nonExistent' in proxy).toBe(false)
  })

  it('returns undefined for non-existent properties', () => {
    const api = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect((proxy as Record<string, unknown>)['missing']).toBeUndefined()
  })

  it('enumerates keys via Object.keys', () => {
    const api = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => api)

    expect(Object.keys(proxy).toSorted()).toEqual(['count', 'greet'])
  })

  it('resolves lazily — follows selectApi changes', () => {
    let current = createTestApi()
    const proxy = createWindowApiForwarder<TestApi>(() => current)

    expect(proxy.count()).toBe(42)

    const replacement = { greet: vi.fn(() => 'replaced'), count: vi.fn(() => 99) }
    current = replacement

    expect(proxy.count()).toBe(99)
    expect(replacement.count).toHaveBeenCalled()
  })

  it('answers a ported name itself and every other name from the API below', async () => {
    const below = new Proxy({} as TestApi, {
      get: () => () => Promise.reject(new Error('not ported'))
    })
    const count = vi.fn(() => 7)
    const proxy = createWindowApiForwarder<TestApi>(() => below, { count })

    expect(proxy.count()).toBe(7)
    expect('count' in proxy).toBe(true)
    await expect(proxy.greet('Kaan')).rejects.toThrow('not ported')
    // A name the ported object only inherits is not one it ports.
    const inherited = (proxy as unknown as { hasOwnProperty: unknown }).hasOwnProperty
    expect(inherited).not.toBe(Object.prototype.hasOwnProperty)
  })
})
