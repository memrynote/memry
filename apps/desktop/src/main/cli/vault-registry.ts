import path from 'node:path'
import { homedir } from 'node:os'
import type { CliKnownVault, CliVaultRegistry } from '@memry/cli'
import { getDefaultVaultPath, getVaults, setDefaultVaultPath } from '../store'

function toCliVault(vault: ReturnType<typeof getVaults>[number]): CliKnownVault {
  return {
    path: vault.path,
    name: vault.name,
    isDefault: vault.isDefault,
    lastOpened: vault.lastOpened
  }
}

function expandVaultReference(reference: string): string {
  if (reference === '~') return homedir()
  if (reference.startsWith(`~${path.sep}`)) {
    return path.join(homedir(), reference.slice(2))
  }
  return path.resolve(reference)
}

function resolveVaultReference(reference: string): string {
  const vaults = getVaults()
  const byName = vaults.filter((vault) => vault.name === reference)
  if (byName.length > 1) {
    throw new Error(`Multiple vaults named ${reference}; use the vault path instead`)
  }
  if (byName.length === 1) return byName[0].path

  const expanded = expandVaultReference(reference)
  const byPath = vaults.find(
    (vault) => vault.path === reference || path.resolve(vault.path) === expanded
  )
  if (byPath) return byPath.path

  throw new Error(`Unknown vault: ${reference}`)
}

export function createDesktopCliVaultRegistry(): CliVaultRegistry {
  return {
    listVaults() {
      return getVaults().map(toCliVault)
    },
    getDefaultVaultPath() {
      return getDefaultVaultPath()
    },
    setDefaultVaultPath(reference) {
      const vaultPath = resolveVaultReference(reference)
      const vault = setDefaultVaultPath(vaultPath)
      if (!vault) throw new Error(`Unknown vault: ${reference}`)
      return toCliVault(vault)
    }
  }
}
