import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { SANDBOX_VAULT_ICON, type SandboxInfo } from '@memry/contracts/vault-api'
import { createLogger } from '../lib/logger'
import { isValidDirectory } from './init'
import { writeVaultIcon } from './vault-icon'

const logger = createLogger('Sandbox')

/** The folder name is the vault's display name, so it stays plain. */
const SANDBOX_FOLDER = 'Sandbox'
const SANDBOX_MARKER_FILE = 'sandbox-vault.json'

/**
 * The sandbox vault lives in the app's own data folder, outside the user's
 * vault list: it is never synced, never offered for removal, and never a page
 * the sidebar swipes to. Its content is generated on this device, so an app
 * update can regenerate it from the new generator.
 */
export function getSandboxPath(): string {
  return path.join(app.getPath('userData'), SANDBOX_FOLDER)
}

export function isSandboxPath(vaultPath: string | null | undefined): boolean {
  return !!vaultPath && path.resolve(vaultPath) === path.resolve(getSandboxPath())
}

function markerPath(): string {
  return path.join(app.getPath('userData'), SANDBOX_MARKER_FILE)
}

/** App version that generated the folder on disk, or null when never generated. */
function readGeneratedVersion(): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))
    const version = (parsed as { appVersion?: unknown } | null)?.appVersion
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

export function getSandboxInfo(): SandboxInfo {
  return { path: getSandboxPath(), exists: readGeneratedVersion() !== null }
}

/**
 * Where the bundled assets are: next to the main bundle, like `tessdata`.
 * electron-builder unpacks them from app.asar.
 */
function assetsDir(): string {
  return path.join(__dirname, 'sandbox-assets').replace('app.asar', 'app.asar.unpacked')
}

/** True when the folder is missing, left over from another app version, or `reset` asks for a fresh one. */
export function sandboxNeedsGeneration(reset = false): boolean {
  return reset || readGeneratedVersion() !== app.getVersion() || !isValidDirectory(getSandboxPath())
}

let generating: Promise<void> | null = null

/**
 * Generates the sandbox when it is missing, stale or `reset`. The caller must
 * not have the sandbox open: generation replaces the folder.
 */
export function ensureSandboxVault(reset = false): Promise<void> {
  if (generating) return generating
  if (!sandboxNeedsGeneration(reset)) return Promise.resolve()

  generating = (async () => {
    const startedAt = performance.now()
    const target = getSandboxPath()
    // Lazy: the generator pulls in the whole app-core stack, which the app only needs here.
    const { generateSandboxAt } = await import('@memry/cli/sandbox/generate')
    await generateSandboxAt(target, new Date(), assetsDir())
    writeVaultIcon(target, { value: SANDBOX_VAULT_ICON, updatedAt: Date.now(), pendingSync: false })
    // Written last: a crash mid-generation leaves no marker, so the next open regenerates.
    fs.writeFileSync(markerPath(), JSON.stringify({ appVersion: app.getVersion() }), 'utf-8')
    logger.info('Sandbox vault generated', { ms: Math.round(performance.now() - startedAt) })
  })().finally(() => {
    generating = null
  })
  return generating
}
