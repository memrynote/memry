import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    vaultSelect: vi.fn(),
    vaultCreate: vi.fn(),
    vaultGetDefaultParent: vi.fn(),
    vaultList: vi.fn(),
    vaultGetStatus: vi.fn(),
    vaultClose: vi.fn(),
    vaultSwitch: vi.fn(),
    vaultRemove: vi.fn(),
    vaultReveal: vi.fn(),
    vaultSetIcon: vi.fn(),
    vaultReindex: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn()
}))

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return mocks.unlisten
    })
  })
  return {
    commands: mocks.commands,
    events: {
      vaultStatusChangedEvent: event('status'),
      vaultListChangedEvent: event('list'),
      vaultErrorEvent: event('error'),
      vaultIndexRecoveredEvent: event('recovered'),
      vaultIndexProgressEvent: event('progress')
    }
  }
})

import {
  onVaultError,
  onVaultIndexProgress,
  onVaultIndexRecovered,
  onVaultListChanged,
  onVaultStatusChanged,
  vaultService
} from './vault-service'

const wireVault = {
  path: '/v/a',
  name: 'a',
  noteCount: 0,
  taskCount: 0,
  lastOpened: '2026-01-01T00:00:00.000Z',
  isDefault: true,
  vaultUuid: null,
  isMissing: false,
  accentColor: '#f97316',
  icon: null
}

const wireStatus = {
  isOpen: true,
  path: '/v/a',
  isIndexing: false,
  indexProgress: 0,
  indexBuilt: null,
  indexTotal: null,
  error: null
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  for (const command of ['vaultClose', 'vaultRemove', 'vaultReveal', 'vaultSetIcon'] as const) {
    mocks.commands[command].mockResolvedValue(null)
  }
})

describe('vault-service over the vault commands', () => {
  it('opens a folder through the picker when no path is given', async () => {
    mocks.commands.vaultSelect.mockResolvedValue({
      success: false,
      vault: null,
      error: 'No folder selected'
    })
    expect(await vaultService.select()).toEqual({
      success: false,
      vault: null,
      error: 'No folder selected'
    })
    expect(mocks.commands.vaultSelect).toHaveBeenCalledWith(null)

    await vaultService.select('/v/a')
    expect(mocks.commands.vaultSelect).toHaveBeenLastCalledWith('/v/a')
  })

  it('drops the null fields the generated types allow, so a vault reads as the contract says', async () => {
    mocks.commands.vaultList.mockResolvedValue({
      vaults: [wireVault],
      currentVault: '/v/a',
      sandbox: { path: '/s', exists: false }
    })
    const { vaults } = await vaultService.getAll()
    expect(vaults[0]).toEqual({
      path: '/v/a',
      name: 'a',
      noteCount: 0,
      taskCount: 0,
      lastOpened: '2026-01-01T00:00:00.000Z',
      isDefault: true,
      isMissing: false,
      accentColor: '#f97316'
    })
    expect('vaultUuid' in vaults[0]).toBe(false)
  })

  it('keeps the create error code the picker branches on', async () => {
    mocks.commands.vaultCreate.mockResolvedValue({
      success: false,
      vault: null,
      error: 'A folder with this name already exists here',
      errorCode: 'already-exists'
    })
    expect(await vaultService.create('/p', 'Taken')).toMatchObject({
      success: false,
      errorCode: 'already-exists'
    })
    expect(mocks.commands.vaultCreate).toHaveBeenCalledWith('/p', 'Taken')
  })

  it('forwards the lifecycle calls', async () => {
    mocks.commands.vaultSwitch.mockResolvedValue({ success: true, vault: wireVault })
    expect((await vaultService.switch('/v/b')).vault?.path).toBe('/v/a')
    expect(mocks.commands.vaultSwitch).toHaveBeenCalledWith('/v/b')
    await vaultService.close()
    await vaultService.remove('/old')
    await vaultService.setIcon('/v/a', 'icon:Book')
    expect(mocks.commands.vaultClose).toHaveBeenCalled()
    expect(mocks.commands.vaultRemove).toHaveBeenCalledWith('/old')
    expect(mocks.commands.vaultSetIcon).toHaveBeenCalledWith('/v/a', 'icon:Book')
  })

  it('reveals the open vault, and nothing when none is open', async () => {
    mocks.commands.vaultGetStatus.mockResolvedValue({ ...wireStatus, isOpen: false, path: null })
    await vaultService.reveal()
    expect(mocks.commands.vaultReveal).not.toHaveBeenCalled()

    mocks.commands.vaultGetStatus.mockResolvedValue(wireStatus)
    await vaultService.reveal()
    expect(mocks.commands.vaultReveal).toHaveBeenCalledWith('/v/a')
  })

  it('reads the launch vault from the startup state, synchronously', () => {
    window.__MEMRY_STARTUP__ = undefined
    expect(vaultService.getStartupPath()).toBeNull()
    window.__MEMRY_STARTUP__ = {
      theme: 'system',
      locale: 'en',
      zoom: 1,
      platform: 'darwin',
      colorTheme: null,
      startupVault: '/v/a'
    }
    expect(vaultService.getStartupPath()).toBe('/v/a')
    window.__MEMRY_STARTUP__ = undefined
  })
})

describe('vault-service events', () => {
  it('reads the status once after subscribing, because earlier events are not replayed', async () => {
    mocks.commands.vaultGetStatus.mockResolvedValue(wireStatus)
    const callback = vi.fn()
    const unsubscribe = onVaultStatusChanged(callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback).toHaveBeenCalledWith({
      isOpen: true,
      path: '/v/a',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })

    mocks.listeners.get('status')?.({ payload: { ...wireStatus, isOpen: false, path: null } })
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribe()
    mocks.listeners.get('status')?.({ payload: wireStatus })
    expect(callback).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(mocks.unlisten).toHaveBeenCalled())
  })

  it('maps the error and list events, and the index recovery reason', async () => {
    const onError = vi.fn()
    const onList = vi.fn()
    const onRecovered = vi.fn()
    onVaultError(onError)
    onVaultListChanged(onList)
    onVaultIndexRecovered(onRecovered)
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(3))

    mocks.listeners.get('error')?.({ payload: { message: 'boom' } })
    mocks.listeners.get('list')?.({ payload: null })
    mocks.listeners.get('recovered')?.({
      payload: { reason: 'missing', detail: 'index.db does not exist' }
    })
    mocks.listeners.get('recovered')?.({
      payload: { reason: 'corrupt', detail: 'integrity check failed' }
    })

    expect(onError).toHaveBeenCalledWith('boom')
    expect(onList).toHaveBeenCalledTimes(1)
    expect(onRecovered.mock.calls.map(([event]) => event.reason)).toEqual(['missing', 'corrupt'])
  })

  it('reindexes through the command and reports progress as the Electron percentage', async () => {
    mocks.commands.vaultReindex.mockResolvedValue(null)
    await vaultService.reindex()
    expect(mocks.commands.vaultReindex).toHaveBeenCalledTimes(1)

    const onProgress = vi.fn()
    onVaultIndexProgress(onProgress)
    await vi.waitFor(() => expect(mocks.listeners.has('progress')).toBe(true))
    for (const [indexBuilt, indexTotal] of [
      [0, 3],
      [1, 3],
      [3, 3],
      [0, 0]
    ]) {
      mocks.listeners.get('progress')?.({ payload: { indexBuilt, indexTotal } })
    }
    expect(onProgress.mock.calls.map(([percent]) => percent)).toEqual([0, 33, 100, 100])
  })
})
