import { describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  return import('./app-shutdown')
}

describe('app-shutdown latch', () => {
  it('reports not shutting down by default', async () => {
    const { isAppShuttingDown } = await load()
    expect(isAppShuttingDown()).toBe(false)
  })

  it('latches to true after beginAppShutdown and stays latched', async () => {
    const { beginAppShutdown, isAppShuttingDown } = await load()
    expect(isAppShuttingDown()).toBe(false)
    beginAppShutdown()
    expect(isAppShuttingDown()).toBe(true)
    beginAppShutdown()
    expect(isAppShuttingDown()).toBe(true)
  })
})
