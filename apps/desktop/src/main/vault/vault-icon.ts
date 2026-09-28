import fs from 'fs'
import { VaultIconSchema } from '@memry/contracts/vault-api'
import { getConfigPath } from './init'
import { writeConfigFileAtomic } from './vault-preferences'

/**
 * A vault's icon as stored in its own `.memry/config.json`.
 *
 * It sits at the top level (`vaultIcon`), not under `preferences`:
 * `writePreferences` rebuilds `preferences` from the fields it knows, so an
 * older app version writing any setting would drop an unknown key there. Both
 * config writers (`writePreferences`, `writeVaultConfig`) spread the existing
 * top level, so every version keeps this key.
 */
export interface StoredVaultIcon {
  /** `icon:<Name>` or an emoji; null when reset to the default icon. */
  value: string | null
  /** Client ms of the last change. The account-wide copy is last writer wins on it. */
  updatedAt: number
  /** Changed here and not yet accepted by the server. */
  pendingSync: boolean
}

const CONFIG_KEY = 'vaultIcon'

function readRawConfig(vaultPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getConfigPath(vaultPath), 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The stored icon, or null when the vault never had one. Tolerant like
 * `readPreferences`: a value this version cannot draw (written by a newer
 * one) reads as no icon, keeping its change time so sync ordering holds.
 */
export function readVaultIcon(vaultPath: string): StoredVaultIcon | null {
  const raw = readRawConfig(vaultPath)?.[CONFIG_KEY]
  if (!raw || typeof raw !== 'object') return null
  const { value, updatedAt, pendingSync } = raw as Record<string, unknown>
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return {
    value: VaultIconSchema.safeParse(value).success ? (value as string) : null,
    updatedAt,
    pendingSync: pendingSync === true
  }
}

export function writeVaultIcon(vaultPath: string, icon: StoredVaultIcon): void {
  const existing = readRawConfig(vaultPath) ?? {}
  writeConfigFileAtomic(getConfigPath(vaultPath), { ...existing, [CONFIG_KEY]: icon })
}
