// Prepares the app data dir of an e2e instance so the app opens a vault at launch. The Tauri
// app has no `TEST_VAULT_PATH`: it opens `currentVault` of `<appDataDir>/memry-config.json`
// when that folder holds `.memry/`, so the harness writes both. Plain ESM with JSDoc types:
// the harness and `scripts/agent-app.mjs` import it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const CONFIG_FILE = 'memry-config.json'

/**
 * Registers `vaultPath` as the current and default vault in a fresh app data dir.
 * @param {string} appDataDir
 * @param {string} vaultPath
 */
export function seedVaultRegistry(appDataDir, vaultPath) {
  mkdirSync(join(vaultPath, '.memry'), { recursive: true })
  mkdirSync(appDataDir, { recursive: true })
  const config = {
    currentVault: vaultPath,
    vaults: [
      {
        path: vaultPath,
        name: basename(vaultPath),
        noteCount: 0,
        taskCount: 0,
        lastOpened: new Date().toISOString(),
        isDefault: true
      }
    ]
  }
  writeFileSync(join(appDataDir, CONFIG_FILE), JSON.stringify(config))
}
