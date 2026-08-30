import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('./telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

const CONFIG_FILE = 'memry-config.json'

describe('store ui zoom', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-store-zoom-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  /** Load a cold copy of the store over `config`, bypassing its module-level cache. */
  async function loadStore(config?: Record<string, unknown>) {
    if (config) {
      fs.writeFileSync(path.join(tempDir, CONFIG_FILE), JSON.stringify(config, null, 2), 'utf-8')
    }
    vi.resetModules()
    return import('./store')
  }

  it('#given a config written before this setting existed #then reads as the default', async () => {
    const { getUiZoomFactor } = await loadStore({ currentVault: '/some/vault', vaults: [] })

    expect(getUiZoomFactor()).toBe(1)
  })

  it('#given no config file at all #then reads as the default', async () => {
    const { getUiZoomFactor } = await loadStore()

    expect(getUiZoomFactor()).toBe(1)
  })

  it('#given a zoom was set #then a cold read returns it from disk', async () => {
    const { setUiZoomFactor } = await loadStore()
    setUiZoomFactor(1.5)

    const reloaded = await loadStore()
    expect(reloaded.getUiZoomFactor()).toBe(1.5)
  })

  it('#given a config holding a value above the ladder #then reads as the highest rung', async () => {
    const { getUiZoomFactor } = await loadStore({ uiZoomFactor: 9 })

    expect(getUiZoomFactor()).toBe(2)
  })

  it('#given a config holding a value below the ladder #then reads as the lowest rung', async () => {
    const { getUiZoomFactor } = await loadStore({ uiZoomFactor: 0.01 })

    expect(getUiZoomFactor()).toBe(0.75)
  })

  it('#given a config hand-edited to a non-numeric value #then reads as the default', async () => {
    const { getUiZoomFactor } = await loadStore({ uiZoomFactor: 'enormous' })

    expect(getUiZoomFactor()).toBe(1)
  })

  it('#given a config holding a value between rungs #then reads as the nearest rung', async () => {
    const { getUiZoomFactor } = await loadStore({ uiZoomFactor: 1.28 })

    expect(getUiZoomFactor()).toBe(1.3)
  })

  it('#given an out-of-range value is written #then it is clamped on the way to disk', async () => {
    const { setUiZoomFactor } = await loadStore()
    setUiZoomFactor(99)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, CONFIG_FILE), 'utf-8'))
    expect(onDisk.uiZoomFactor).toBe(2)
  })

  it('#given a zoom is persisted #then the rest of the config survives', async () => {
    const { setUiZoomFactor } = await loadStore({ currentVault: '/keep/me', vaults: [] })
    setUiZoomFactor(1.15)

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, CONFIG_FILE), 'utf-8'))
    expect(onDisk.currentVault).toBe('/keep/me')
    expect(onDisk.uiZoomFactor).toBe(1.15)
  })
})
