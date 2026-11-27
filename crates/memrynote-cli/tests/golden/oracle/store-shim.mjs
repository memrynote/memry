// The registry functions of apps/desktop/src/main/store.ts that vault-registry.ts calls, over the
// scenario's memry-config.json (MEMRY_GOLDEN_CONFIG) instead of electron-store. Bodies copied
// from store.ts; `store.get` falls back to its defaults (`vaults: []`, `currentVault: null`).
import fs from 'node:fs'

const file = process.env.MEMRY_GOLDEN_CONFIG
const DEFAULTS = { vaults: [], currentVault: null }

function read() {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
}

const store = {
  get(key) {
    const value = read()[key]
    return value === undefined ? DEFAULTS[key] : value
  },
  set(key, value) {
    fs.writeFileSync(file, JSON.stringify({ ...read(), [key]: value }, null, 2))
  }
}

export function getCurrentVaultPath() {
  return store.get('currentVault')
}

export function setCurrentVaultPath(vaultPath) {
  store.set('currentVault', vaultPath)
}

export function getVaults() {
  return store.get('vaults')
}

export function removeVault(vaultPath) {
  const vaults = store.get('vaults')
  store.set(
    'vaults',
    vaults.filter((v) => v.path !== vaultPath)
  )
}

export function getDefaultVaultPath() {
  return store.get('vaults').find((vault) => vault.isDefault)?.path ?? null
}

export function setDefaultVaultPath(vaultPath) {
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
