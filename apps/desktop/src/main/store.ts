import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { LocaleSchema, type Locale } from '@memry/contracts/locale-api'
import { createLogger } from './lib/logger'

const logger = createLogger('Store')

/**
 * Vault information stored in config
 */
export interface StoredVaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
  /** Server vault uuid; stamped when the vault is opened while sync is set up */
  vaultUuid?: string
}

export interface CachedEntitlement {
  isPaid: boolean
  plan: string
  status: string
}

/**
 * Sync-related persistent state
 */
export interface SyncStoreData {
  recoveryPhraseConfirmed?: boolean
  email?: string
  /** Server device id for this install; seeds device rows in newly provisioned vault DBs */
  deviceId?: string
  /** Last known account vault list (decrypted names) for offline switcher display */
  accountVaultsCache?: AccountVaultsCache
  /** Cache-first entitlement snapshot; gates whether sync runs without a server call */
  entitlement?: CachedEntitlement
}

export interface AccountVaultsCache {
  fetchedAt: number
  vaults: Array<{
    vaultUuid: string
    name: string | null
    itemCount: number
    createdAt: number | null
  }>
}

export interface AgentStoreData {
  disclosureAccepted?: boolean
  accessMode?: 'vault_only' | 'computer_access'
  toolApprovalMode?: 'always_accept' | 'ask'
  localProvider?: {
    preset?: 'ollama' | 'lm_studio' | 'llama_cpp' | 'custom'
    baseUrl?: string
    model?: string
    allowNonLoopback?: boolean
  }
}

/**
 * Application store schema
 */
interface StoreSchema {
  /** App-level locale used before a vault is open */
  locale: Locale | null
  /** Path to the currently open vault */
  currentVault: string | null
  /** List of known vaults */
  vaults: StoredVaultInfo[]
  /** Sync configuration */
  sync: SyncStoreData
  /** Local agent-chat preferences */
  agent: AgentStoreData
  /** Localhost capture: origins that have completed the pairing handshake */
  captureAllowedOrigins: string[]
}

const CONFIG_FILE = 'memry-config.json'

const defaultData: StoreSchema = {
  locale: null,
  currentVault: null,
  vaults: [],
  sync: {},
  agent: {},
  captureAllowedOrigins: []
}

/** In-memory cache — populated on first read, updated on every write. */
let cache: StoreSchema | null = null

/**
 * Get the config file path in the app's userData directory
 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, CONFIG_FILE)
}

/**
 * Read the config file (only called when cache is cold).
 */
function readConfig(): StoreSchema {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content) as Partial<StoreSchema>
      return { ...defaultData, ...parsed }
    }
  } catch (error) {
    logger.error('Error reading config:', error)
  }
  return { ...defaultData }
}

/**
 * Write the config file and keep the cache in sync.
 */
function writeConfig(data: StoreSchema): void {
  try {
    const configPath = getConfigPath()
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8')
    cache = data
  } catch (error) {
    logger.error('Error writing config:', error)
  }
}

function getCache(): StoreSchema {
  if (!cache) {
    cache = readConfig()
  }
  return cache
}

/**
 * Simple store object that mimics electron-store API
 */
export const store = {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    return getCache()[key]
  },

  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    const data = { ...getCache(), [key]: value }
    writeConfig(data)
  }
}

/**
 * Get the current vault path
 */
export function getCurrentVaultPath(): string | null {
  return store.get('currentVault')
}

/**
 * Set the current vault path
 */
export function setCurrentVaultPath(path: string | null): void {
  store.set('currentVault', path)
}

/**
 * Get the app-level locale used before a vault is open.
 */
export function getStoredLocale(): Locale | null {
  const parsed = LocaleSchema.safeParse(store.get('locale'))
  return parsed.success ? parsed.data : null
}

/**
 * Persist the app-level locale used by shell surfaces such as the vault picker.
 */
export function setStoredLocale(locale: Locale): void {
  store.set('locale', LocaleSchema.parse(locale))
}

/**
 * Get all known vaults
 */
export function getVaults(): StoredVaultInfo[] {
  return store.get('vaults')
}

/**
 * Add or update a vault in the known vaults list
 */
export function upsertVault(vault: StoredVaultInfo): void {
  const vaults = store.get('vaults')
  const existingIndex = vaults.findIndex((v) => v.path === vault.path)

  if (existingIndex >= 0) {
    vaults[existingIndex] = vault
  } else {
    vaults.push(vault)
  }

  store.set('vaults', vaults)
}

/**
 * Remove a vault from the known vaults list
 */
export function removeVault(vaultPath: string): void {
  const vaults = store.get('vaults')
  store.set(
    'vaults',
    vaults.filter((v) => v.path !== vaultPath)
  )
}

/**
 * Find a vault by path
 */
export function findVault(vaultPath: string): StoredVaultInfo | undefined {
  return store.get('vaults').find((v) => v.path === vaultPath)
}

/**
 * Get the install-wide server device id
 */
export function getStoredDeviceId(): string | undefined {
  return store.get('sync').deviceId
}

/**
 * Persist the install-wide server device id
 */
export function setStoredDeviceId(deviceId: string): void {
  store.set('sync', { ...store.get('sync'), deviceId })
}

/**
 * Get the cached account vault list
 */
export function getAccountVaultsCache(): AccountVaultsCache | undefined {
  return store.get('sync').accountVaultsCache
}

/**
 * Replace the cached account vault list
 */
export function setAccountVaultsCache(accountVaultsCache: AccountVaultsCache): void {
  store.set('sync', { ...store.get('sync'), accountVaultsCache })
}

/**
 * Get the default vault path used by CLI commands when --vault is omitted.
 */
export function getDefaultVaultPath(): string | null {
  return store.get('vaults').find((vault) => vault.isDefault)?.path ?? null
}

/**
 * Mark one known vault as the default used by CLI commands.
 */
export function setDefaultVaultPath(vaultPath: string): StoredVaultInfo | null {
  const vaults = store.get('vaults')
  const target = vaults.find((vault) => vault.path === vaultPath)
  if (!target) return null

  const updated = vaults.map((vault) => ({
    ...vault,
    isDefault: vault.path === vaultPath
  }))
  store.set('vaults', updated)

  return updated.find((vault) => vault.path === vaultPath) ?? null
}

/**
 * Update the lastOpened timestamp for a vault
 */
export function touchVault(vaultPath: string): void {
  const vault = findVault(vaultPath)
  if (vault) {
    upsertVault({
      ...vault,
      lastOpened: new Date().toISOString()
    })
  }
}
