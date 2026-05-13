import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createDesktopCliVaultRegistry } from './vault-registry'

const store = vi.hoisted(() => ({
  vaults: [
    {
      path: '/vaults/personal',
      name: 'personal',
      noteCount: 1,
      taskCount: 1,
      lastOpened: '2026-05-13T00:00:00.000Z',
      isDefault: true
    },
    {
      path: '/vaults/work',
      name: 'work',
      noteCount: 2,
      taskCount: 2,
      lastOpened: '2026-05-13T01:00:00.000Z',
      isDefault: false
    }
  ],
  setDefaultVaultPath: vi.fn((vaultPath: string) => {
    const vault = store.vaults.find((item) => item.path === vaultPath)
    if (!vault) return null
    store.vaults = store.vaults.map((item) => ({
      ...item,
      isDefault: item.path === vaultPath
    }))
    return store.vaults.find((item) => item.path === vaultPath) ?? null
  })
}))

vi.mock('../store', () => ({
  getVaults: () => store.vaults,
  getDefaultVaultPath: () => store.vaults.find((vault) => vault.isDefault)?.path ?? null,
  setDefaultVaultPath: (vaultPath: string) => store.setDefaultVaultPath(vaultPath)
}))

describe('desktop CLI vault registry', () => {
  beforeEach(() => {
    store.vaults = [
      {
        path: '/vaults/personal',
        name: 'personal',
        noteCount: 1,
        taskCount: 1,
        lastOpened: '2026-05-13T00:00:00.000Z',
        isDefault: true
      },
      {
        path: '/vaults/work',
        name: 'work',
        noteCount: 2,
        taskCount: 2,
        lastOpened: '2026-05-13T01:00:00.000Z',
        isDefault: false
      }
    ]
    store.setDefaultVaultPath.mockClear()
  })

  it('lists known vaults and exposes the default vault path', async () => {
    const registry = createDesktopCliVaultRegistry()

    expect(await registry.getDefaultVaultPath()).toBe('/vaults/personal')
    expect(await registry.listVaults()).toEqual([
      expect.objectContaining({ path: '/vaults/personal', name: 'personal', isDefault: true }),
      expect.objectContaining({ path: '/vaults/work', name: 'work', isDefault: false })
    ])
  })

  it('sets the default vault by name for CLI vault use', async () => {
    const registry = createDesktopCliVaultRegistry()

    expect(await registry.setDefaultVaultPath('work')).toEqual(
      expect.objectContaining({ path: '/vaults/work', isDefault: true })
    )

    expect(store.setDefaultVaultPath).toHaveBeenCalledWith('/vaults/work')
  })
})
