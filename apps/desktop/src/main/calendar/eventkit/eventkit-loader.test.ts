import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bridgeModuleLoaded: vi.fn(),
  createEventKitBridge: vi.fn(() => ({ dispose: vi.fn() }))
}))

// The factory runs only if something actually imports the bridge module, so
// `bridgeModuleLoaded` records whether it was ever required.
vi.mock('./eventkit-bridge', () => {
  mocks.bridgeModuleLoaded()
  return { createEventKitBridge: mocks.createEventKitBridge }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/nonexistent-app',
    getPath: () => '/nonexistent-app/MemryNote'
  }
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { disposeEventKitBridge, loadEventKitBridge } from './eventkit-loader'

describe('loadEventKitBridge (#1405)', () => {
  let dir: string
  let helperPath: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'memry-eventkit-loader-'))
    helperPath = path.join(dir, 'memry-eventkit')
    writeFileSync(helperPath, '')
  })

  afterEach(async () => {
    await disposeEventKitBridge()
    delete process.env.MEMRY_EVENTKIT_HELPER
    vi.clearAllMocks()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.each(['win32', 'linux'] as const)(
    'never requires the bridge module on %s, even with a helper on disk',
    async (platform) => {
      process.env.MEMRY_EVENTKIT_HELPER = helperPath

      await expect(loadEventKitBridge(platform)).resolves.toEqual({
        status: 'unsupported_platform'
      })

      expect(mocks.bridgeModuleLoaded).not.toHaveBeenCalled()
      expect(mocks.createEventKitBridge).not.toHaveBeenCalled()
    }
  )

  it('reports unavailable on darwin when the helper is missing, without loading the bridge', async () => {
    process.env.MEMRY_EVENTKIT_HELPER = path.join(dir, 'missing')

    await expect(loadEventKitBridge('darwin')).resolves.toEqual({
      status: 'unavailable',
      reason: 'helper_missing'
    })
    expect(mocks.bridgeModuleLoaded).not.toHaveBeenCalled()
  })

  it('loads the bridge once on darwin and hands every caller the same instance', async () => {
    process.env.MEMRY_EVENTKIT_HELPER = helperPath

    const first = await loadEventKitBridge('darwin')
    const second = await loadEventKitBridge('darwin')

    expect(first.status).toBe('available')
    expect(second).toBe(first)
    expect(mocks.createEventKitBridge).toHaveBeenCalledTimes(1)
    expect(mocks.createEventKitBridge).toHaveBeenCalledWith({ command: helperPath })
  })

  it('retries after a failed load instead of caching the failure', async () => {
    process.env.MEMRY_EVENTKIT_HELPER = path.join(dir, 'missing')
    expect((await loadEventKitBridge('darwin')).status).toBe('unavailable')

    process.env.MEMRY_EVENTKIT_HELPER = helperPath
    expect((await loadEventKitBridge('darwin')).status).toBe('available')
  })
})
