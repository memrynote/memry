// Keychain teardown for e2e runs on every OS. Plain ESM with JSDoc types: the harness and the
// Step 04 (#3521) scripts import it, and `node --test` runs its tests without a compiler.
//
// The OS keychain is machine-global and outlives the throwaway app data dir. Every e2e app
// runs under `MEMRY_DEVICE=e2e-<uuid>[-A|-B]`, and the sync accounts are suffixed with it
// (`apps/desktop/src/main/crypto/keychain-account.ts`), so a run mints a handful of items
// that only this module reclaims. Best effort: a failure is logged and never thrown.
import { spawnSync } from 'node:child_process'

export const SYNC_SERVICE = 'com.memry.sync'

/** The `KEYCHAIN_ENTRIES` accounts of `@memry/contracts/crypto`; a test keeps them in step. */
export const KEYCHAIN_ACCOUNTS = [
  'master-key',
  'device-signing-key',
  'access-token',
  'refresh-token',
  'setup-token'
]

/**
 * Only an e2e launch's accounts are ever purged. Guards against a stray `A`/`B`/`C`/`dev`
 * (real local dev vaults) or an unset device (production's bare `master-key`).
 */
export const E2E_DEVICE_ID = /^e2e-[A-Za-z0-9-]+$/

/**
 * Accounts that are never deleted: production (bare), the shared dev account and the explicit
 * local dev devices. None contains `-e2e-`, so the matcher rejects them already; an exact
 * denylist means a future matcher bug still cannot delete a developer's real master key.
 */
export const PROTECTED_ACCOUNTS = new Set([
  'master-key',
  'master-key-dev',
  'master-key-A',
  'master-key-B',
  'master-key-C',
  'device-signing-key',
  'device-signing-key-dev',
  'device-signing-key-A',
  'device-signing-key-B',
  'device-signing-key-C',
  'access-token',
  'refresh-token',
  'setup-token',
  'pairing-token'
])

/** `master-key-e2e-<uuid>-A`, `setup-token-e2e-vault-deletion-<uuid>`, ... */
const E2E_SYNC_ACCOUNT = /^[a-z-]+-e2e-[A-Za-z0-9@._-]+$/

/** Electron safeStorage: service `<app.name> Safe Storage`, app.name `memry-<MEMRY_DEVICE>`. */
const E2E_SAFE_STORAGE_SERVICE = /^memry-e2e-[A-Za-z0-9-]+ Safe Storage$/

/**
 * @param {string | undefined} deviceId
 * @returns {deviceId is string}
 */
export function isE2eDeviceId(deviceId) {
  return !!deviceId && E2E_DEVICE_ID.test(deviceId)
}

/**
 * @param {string} deviceId
 * @returns {{ service: string, account: string }[]}
 */
export function keychainAccountsForDevice(deviceId) {
  return KEYCHAIN_ACCOUNTS.map((account) => ({
    service: SYNC_SERVICE,
    account: `${account}-${deviceId}`
  }))
}

/**
 * @param {{ service?: string, account?: string }} entry
 * @returns {boolean}
 */
export function isPurgeableE2eEntry({ service, account }) {
  if (!service || !account) return false
  if (PROTECTED_ACCOUNTS.has(account)) return false
  if (service === SYNC_SERVICE) {
    return account.includes('-e2e-') && E2E_SYNC_ACCOUNT.test(account)
  }
  return E2E_SAFE_STORAGE_SERVICE.test(service)
}

/**
 * `security dump-keychain` output to `{ service, account }` pairs. Attribute values are quoted
 * blobs, optionally preceded by a hex dump for non-ASCII values, or the literal `<NULL>`.
 * @param {string} text
 */
export function parseKeychainDump(text) {
  const attr = /^\s*"(acct|svce)"<blob>=(?:0x[0-9A-Fa-f]+\s+)?(?:"((?:[^"\\]|\\.)*)"|<NULL>)\s*$/
  const entries = []
  let current = {}
  const flush = () => {
    if (current.acct !== undefined || current.svce !== undefined) {
      entries.push({ service: current.svce, account: current.acct })
    }
    current = {}
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('keychain:')) {
      flush()
      continue
    }
    const match = attr.exec(line)
    if (match) current[match[1]] = match[2]
  }
  flush()
  return entries
}

/**
 * `cmdkey /list` output to credential targets. A line reads `Target: LegacyGeneric:target=<t>`
 * (older Windows prints `Target: <t>`); the target is what `cmdkey /delete:` takes.
 * @param {string} text
 * @returns {string[]}
 */
export function parseCmdkeyList(text) {
  const targets = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Target:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const value = match[1]
    const inner = /^[A-Za-z]+:target=(.*)$/.exec(value)
    targets.push(inner ? inner[1] : value)
  }
  return targets
}

/**
 * The Windows targets one e2e device minted: those naming the sync service and the device.
 * @param {string[]} targets
 * @param {string} deviceId
 */
export function windowsTargetsForDevice(targets, deviceId) {
  if (!isE2eDeviceId(deviceId)) return []
  return targets.filter(
    (target) => target.includes(SYNC_SERVICE) && target.includes(`-${deviceId}`)
  )
}

/**
 * `secret-tool search --all service com.memry.sync` output to `{ service, account }` pairs.
 * Items are blocks that start with `[/org/freedesktop/secrets/...]` and carry
 * `attribute.<name> = <value>` lines.
 * @param {string} text
 */
export function parseSecretToolSearch(text) {
  const entries = []
  let current
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      if (current) entries.push(current)
      current = {}
      continue
    }
    const match = /^attribute\.(service|username)\s*=\s*(.*)$/.exec(line)
    if (match && current) {
      current[match[1] === 'service' ? 'service' : 'account'] = match[2]
    }
  }
  if (current) entries.push(current)
  return entries.filter((entry) => entry.service || entry.account)
}

/**
 * @param {{ service?: string, account?: string }[]} entries
 * @param {string} deviceId
 */
export function linuxAccountsForDevice(entries, deviceId) {
  if (!isE2eDeviceId(deviceId)) return []
  return entries
    .filter(
      (entry) =>
        entry.service === SYNC_SERVICE &&
        entry.account?.endsWith(`-${deviceId}`) &&
        !PROTECTED_ACCOUNTS.has(entry.account)
    )
    .map((entry) => /** @type {string} */ (entry.account))
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ log?: (message: string) => void }} [options]
 */
function run(command, args, { log = console.warn } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024
  })
  if (result.error) {
    log(`keychain cleanup: ${command} failed: ${result.error.message}`)
    return { status: null, stdout: '' }
  }
  return { status: result.status, stdout: result.stdout ?? '' }
}

/**
 * Delete every keychain item the app minted for `deviceId`. Does nothing for an id outside
 * `E2E_DEVICE_ID`.
 * @param {string | undefined} deviceId
 * @param {{ log?: (message: string) => void }} [options]
 */
export function purgeKeychainForDevice(deviceId, options = {}) {
  if (!isE2eDeviceId(deviceId)) return
  const log = options.log ?? console.warn
  try {
    if (process.platform === 'darwin') {
      for (const { service, account } of keychainAccountsForDevice(deviceId)) {
        run('security', ['delete-generic-password', '-s', service, '-a', account], { log })
      }
      // Electron's safeStorage item; harmless when absent.
      run(
        'security',
        [
          'delete-generic-password',
          '-s',
          `memry-${deviceId} Safe Storage`,
          '-a',
          `memry-${deviceId} Key`
        ],
        { log }
      )
    } else if (process.platform === 'win32') {
      const listed = run('cmdkey', ['/list'], { log })
      for (const target of windowsTargetsForDevice(parseCmdkeyList(listed.stdout), deviceId)) {
        run('cmdkey', [`/delete:${target}`], { log })
      }
    } else if (process.platform === 'linux') {
      const listed = run('secret-tool', ['search', '--all', 'service', SYNC_SERVICE], { log })
      for (const account of linuxAccountsForDevice(
        parseSecretToolSearch(listed.stdout),
        deviceId
      )) {
        run('secret-tool', ['clear', 'service', SYNC_SERVICE, 'username', account], { log })
      }
    }
  } catch (error) {
    log(`keychain cleanup for ${deviceId} failed: ${error}`)
  }
}
