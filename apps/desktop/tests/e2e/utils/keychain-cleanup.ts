/**
 * Keychain teardown for E2E runs.
 *
 * Every launch sets `MEMRY_DEVICE=e2e-<uuid>-A|B` (see electron-lifecycle), and
 * `resolveKeychainAccount` suffixes every KEYCHAIN_ENTRIES account with it. The
 * OS keychain is machine-global and outlives the throwaway userData dir, so
 * without this the suite mints ~5 permanent keychain items per app launch and
 * never reclaims them (a local machine had 1315 leaked `com.memry.sync` rows).
 *
 * macOS only: `security(1)` is the zero-dependency way to reach the login
 * keychain from the Playwright process. keytar is built for the Electron ABI in
 * this workspace, so requiring it from Node would hit ERR_DLOPEN_FAILED. Linux
 * CI runs headless with no libsecret daemon, so nothing is persisted there.
 */

import { spawnSync } from 'child_process'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

/**
 * Only ever purge accounts minted by an E2E launch. Guards against a stray
 * `deviceId` of `A`/`B`/`C`/`dev` (real local dev vaults) or `undefined`
 * (production's bare `master-key`) wiping a real developer's keys.
 */
export const E2E_DEVICE_ID = /^e2e-[A-Za-z0-9-]+$/

export function isE2eDeviceId(deviceId: string | undefined): deviceId is string {
  return !!deviceId && E2E_DEVICE_ID.test(deviceId)
}

export function keychainAccountsForDevice(
  deviceId: string
): { service: string; account: string }[] {
  return Object.values(KEYCHAIN_ENTRIES).map((entry) => ({
    service: entry.service,
    account: `${entry.account}-${deviceId}`
  }))
}

function deleteGenericPassword(service: string, account: string): boolean {
  const result = spawnSync('security', ['delete-generic-password', '-s', service, '-a', account], {
    stdio: 'ignore',
    timeout: 10_000
  })
  return result.status === 0
}

/**
 * Delete every keychain item this run created. Best-effort: a missing item exits
 * non-zero (44) and is not an error, and no failure here may fail a test.
 */
export function purgeKeychainForDevice(deviceId: string | undefined): void {
  if (process.platform !== 'darwin') return
  if (!isE2eDeviceId(deviceId)) return

  try {
    for (const { service, account } of keychainAccountsForDevice(deviceId)) {
      deleteGenericPassword(service, account)
    }
    // Electron's safeStorage keeps its own item under `<app.name> Safe Storage`,
    // and app.name is `memry-<MEMRY_DEVICE>`, so it leaks per run too.
    deleteGenericPassword(`memry-${deviceId} Safe Storage`, `memry-${deviceId} Key`)
  } catch {
    // best-effort cleanup — never fail teardown over the keychain
  }
}
