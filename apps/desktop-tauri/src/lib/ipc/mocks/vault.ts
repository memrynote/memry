import type { MockRouteMap } from './types'
import { mockTimestamp } from './types'

/**
 * Vault mock handlers.
 *
 * Shapes mirror preload-types.ts: VaultInfo (path/name/noteCount/taskCount/
 * lastOpened/isDefault) and GetVaultsResponse ({ vaults, currentVault }).
 * The older mock returned a bare array which made the renderer crash with
 * "undefined is not an object (evaluating 'vaults.length')" in
 * vault-onboarding.tsx.
 */
interface MockVault {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
}

interface MockVaultStatus {
  isOpen: boolean
  path: string | null
  isIndexing: boolean
  indexProgress: number
  error: string | null
}

interface MockVaultConfig {
  excludePatterns: string[]
  defaultNoteFolder: string
  journalFolder: string
  attachmentsFolder: string
}

const vaults: MockVault[] = [
  {
    path: '/mock/path/primary',
    name: 'Primary (Mock)',
    noteCount: 12,
    taskCount: 5,
    lastOpened: new Date(mockTimestamp(0)).toISOString(),
    isDefault: true
  },
  {
    path: '/mock/path/secondary',
    name: 'Secondary (Mock)',
    noteCount: 3,
    taskCount: 0,
    lastOpened: new Date(mockTimestamp(5)).toISOString(),
    isDefault: false
  }
]

let currentVault: string | null = vaults[0]!.path

let status: MockVaultStatus = {
  isOpen: true,
  path: vaults[0]!.path,
  isIndexing: false,
  indexProgress: 1,
  error: null
}

let config: MockVaultConfig = {
  excludePatterns: ['.git', 'node_modules', '.DS_Store'],
  defaultNoteFolder: 'Notes',
  journalFolder: 'Journal',
  attachmentsFolder: 'attachments'
}

function vaultByPath(path: string): MockVault | undefined {
  return vaults.find((v) => v.path === path)
}

export const vaultRoutes: MockRouteMap = {
  vault_get_all: async () => ({ vaults, currentVault }),
  vault_get_status: async () => status,
  vault_get_config: async () => config,
  vault_update_config: async (args) => {
    const patch = args as Partial<typeof config>
    config = { ...config, ...patch }
    return config
  },
  vault_select: async (args) => {
    const { path } = (args ?? {}) as { path?: string }
    const resolved = path ?? '/mock/path/primary'
    const existing = vaultByPath(resolved)
    const vault: MockVault = existing ?? {
      path: resolved,
      name: 'Selected (Mock)',
      noteCount: 0,
      taskCount: 0,
      lastOpened: new Date().toISOString(),
      isDefault: false
    }
    if (!existing) vaults.push(vault)
    currentVault = resolved
    return { success: true, vault }
  },
  vault_create: async (args) => {
    const { path, name } = args as { path: string; name: string }
    const vault: MockVault = {
      path,
      name,
      noteCount: 0,
      taskCount: 0,
      lastOpened: new Date().toISOString(),
      isDefault: false
    }
    vaults.push(vault)
    currentVault = path
    return { success: true, vault }
  },
  vault_switch: async (args) => {
    const { path } = args as { path: string }
    currentVault = path
    status = { ...status, path, isOpen: true }
    return { success: true }
  },
  vault_remove: async (args) => {
    const { path } = args as { path: string }
    const idx = vaults.findIndex((v) => v.path === path)
    if (idx >= 0) vaults.splice(idx, 1)
    if (currentVault === path) currentVault = vaults[0]?.path ?? null
    return { success: true }
  },
  vault_close: async () => {
    status = { ...status, isOpen: false, path: null }
    return { success: true }
  },
  vault_reveal: async () => ({ success: true }),
  vault_reindex: async () => ({ success: true, filesIndexed: 12, duration: 123 })
}
