import type { MockRouteMap } from './types'
import { mockTimestamp } from './types'

interface MockVault {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  isActive: boolean
}

interface MockVaultStatus {
  state: 'open' | 'closed' | 'locked'
  path: string | null
  noteCount: number
  indexProgress: number
}

const vaults: MockVault[] = [
  {
    id: 'vault-primary',
    name: 'Primary (Mock)',
    path: '/mock/path/primary',
    lastOpenedAt: mockTimestamp(0),
    isActive: true
  },
  {
    id: 'vault-secondary',
    name: 'Secondary (Mock)',
    path: '/mock/path/secondary',
    lastOpenedAt: mockTimestamp(5),
    isActive: false
  }
]

let status: MockVaultStatus = {
  state: 'open',
  path: vaults[0]!.path,
  noteCount: 12,
  indexProgress: 1
}

let config = {
  name: vaults[0]!.name,
  path: vaults[0]!.path,
  crdtEnabled: true,
  autoOpenLast: true
}

export const vaultRoutes: MockRouteMap = {
  vault_get_all: async () => vaults,
  vault_get_status: async () => status,
  vault_get_config: async () => config,
  vault_update_config: async (args) => {
    const patch = args as Partial<typeof config>
    config = { ...config, ...patch }
    return config
  },
  vault_select: async (args) => {
    const { path } = args as { path: string }
    return {
      id: 'vault-selected',
      name: 'Selected (Mock)',
      path,
      lastOpenedAt: Date.now(),
      isActive: true
    }
  },
  vault_switch: async (args) => {
    const { path } = args as { path: string }
    vaults.forEach((v) => {
      v.isActive = v.path === path
    })
    status = { ...status, path }
    return { ok: true, active: path }
  },
  vault_remove: async (args) => {
    const { path } = args as { path: string }
    const idx = vaults.findIndex((v) => v.path === path)
    if (idx >= 0) vaults.splice(idx, 1)
    return { ok: true }
  },
  vault_close: async () => {
    status = { ...status, state: 'closed' }
    return status
  },
  vault_reveal: async () => ({ ok: true }),
  vault_reindex: async () => ({ ok: true, filesIndexed: 12, duration: 123 })
}
