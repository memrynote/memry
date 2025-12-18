import { app } from 'electron'
import fs from 'fs'
import path from 'path'

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
}

/**
 * Application store schema
 */
interface StoreSchema {
  /** Path to the currently open vault */
  currentVault: string | null
  /** List of known vaults */
  vaults: StoredVaultInfo[]
}

const CONFIG_FILE = 'memry-config.json'

const defaultData: StoreSchema = {
  currentVault: null,
  vaults: []
}

/**
 * Get the config file path in the app's userData directory
 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
  return path.join(userDataPath, CONFIG_FILE)
}

/**
 * Read the config file
 */
function readConfig(): StoreSchema {
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      return { ...defaultData, ...JSON.parse(content) }
    }
  } catch (error) {
    console.error('Error reading config:', error)
  }
  return defaultData
}

/**
 * Write the config file
 */
function writeConfig(data: StoreSchema): void {
  try {
    const configPath = getConfigPath()
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    console.error('Error writing config:', error)
  }
}

/**
 * Simple store object that mimics electron-store API
 */
export const store = {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    const data = readConfig()
    return data[key]
  },

  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    const data = readConfig()
    data[key] = value
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
