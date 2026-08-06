import { app } from 'electron'
import keytar from 'keytar'
import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './lib/logger'
import { SECRET_STORE_FILENAME } from './secrets/secret-storage'
// Runs before the telemetry runtime exists; trackMainError events are held in
// the early buffer (telemetry/track.ts) and shipped once the runtime installs.
import { trackMainError } from './telemetry/diagnostics'

const logger = createLogger('AppIdentity')

const APP_NAME = 'memrynote'

// macOS safeStorage derives its encryption key from the Keychain item
// "<app name> Safe Storage" (empirically verified: `@memry/desktop Safe
// Storage` and `memry-A Safe Storage` items exist on machines that ran those
// identities). Renaming the app without carrying this item over would leave
// every ciphertext in secure-secrets.json undecryptable.
const LEGACY_SAFE_STORAGE = { service: '@memry/desktop Safe Storage', account: '@memry/desktop' }
const NEW_SAFE_STORAGE = { service: `${APP_NAME} Safe Storage`, account: APP_NAME }

interface IdentityDirs {
  legacyDir?: string
  newDir?: string
}

// lstat so a compatibility symlink left by a prior migration never counts as
// a real directory (following it would re-migrate a dir onto itself).
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Adopt the `memrynote` runtime identity for production launches.
 *
 * Packaged builds still identify as the package.json name `@memry/desktop`
 * (electron-builder's productName never reaches the asar package.json), which
 * leaks scoped-package folder names (`Application Support/@memry/desktop`)
 * and couples the safeStorage key to that name. This renames the app and
 * carries every name-coupled artifact over:
 *  - userData moves `@memry/desktop` → `memrynote` (atomic same-volume rename,
 *    with a compatibility symlink left behind so downgraded binaries and
 *    stored absolute paths keep resolving),
 *  - the macOS Safe Storage keychain item is copied to the new name (returned
 *    promise; the caller awaits it before anything decrypts secrets),
 *  - on Linux a populated safeStorage store blocks the rename entirely —
 *    keyrings key the item by app name and keytar cannot write Chromium's
 *    libsecret schema, so those installs keep the legacy identity.
 *
 * Every failure path keeps the legacy identity for this launch and retries on
 * the next one; the app never boots with an empty profile. Dev profiles
 * (MEMRY_DEVICE) never call this — they keep their per-device `memry-<id>`
 * identity — and a custom userData (e2e `--user-data-dir`) is left alone.
 */
export function applyMemrynoteIdentity(dirs?: IdentityDirs): Promise<void> {
  try {
    const appData = app.getPath('appData')
    const legacyDir = dirs?.legacyDir ?? join(appData, '@memry', 'desktop')
    const newDir = dirs?.newDir ?? join(appData, APP_NAME)

    if (app.getPath('userData') !== legacyDir) return Promise.resolve()

    const alreadyMigrated = isRealDir(newDir)
    const activeDir = alreadyMigrated ? newDir : legacyDir
    const storeInUse = existsSync(join(activeDir, SECRET_STORE_FILENAME))

    if (process.platform === 'linux' && storeInUse) {
      logger.warn('safeStorage store present on Linux; keeping the legacy app identity')
      return Promise.resolve()
    }

    if (!alreadyMigrated && isRealDir(legacyDir)) {
      try {
        renameSync(legacyDir, newDir)
      } catch (err) {
        logger.error('Could not move legacy userData; keeping the legacy identity this launch', {
          error: err
        })
        trackMainError('app_identity', 'userdata_rename_failed', err)
        return Promise.resolve()
      }
      try {
        symlinkSync(newDir, legacyDir, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (err) {
        logger.warn('Could not leave a compatibility symlink at the legacy userData path', {
          error: err
        })
      }
    }

    app.setName(APP_NAME)
    app.setPath('userData', newDir)

    if (process.platform === 'darwin' && storeInUse) {
      return carrySafeStorageKeychainKey()
    }
    return Promise.resolve()
  } catch (err) {
    try {
      logger.error('App identity migration failed; keeping the legacy identity', { error: err })
      trackMainError('app_identity', 'identity_migration_failed', err)
    } catch {
      /* logging must never break startup */
    }
    return Promise.resolve()
  }
}

// Best-effort and idempotent. On failure the store's ciphertexts are
// unreadable this run, which secret-storage.ts surfaces as "could not be read
// this run" (transient, never absent — no destructive caller acts on it), and
// the copy retries on the next launch. The legacy item is never deleted.
async function carrySafeStorageKeychainKey(): Promise<void> {
  try {
    const existing = await keytar.getPassword(NEW_SAFE_STORAGE.service, NEW_SAFE_STORAGE.account)
    if (existing !== null) return
    const legacy = await keytar.getPassword(
      LEGACY_SAFE_STORAGE.service,
      LEGACY_SAFE_STORAGE.account
    )
    if (legacy === null) {
      logger.warn('No legacy Safe Storage keychain item to carry over')
      return
    }
    await keytar.setPassword(NEW_SAFE_STORAGE.service, NEW_SAFE_STORAGE.account, legacy)
    const readBack = await keytar.getPassword(NEW_SAFE_STORAGE.service, NEW_SAFE_STORAGE.account)
    if (readBack !== legacy) throw new Error('read-back mismatch after keychain copy')
    logger.info('Carried the Safe Storage keychain key over to the memrynote identity')
  } catch (err) {
    logger.error('Safe Storage keychain carry-over failed (will retry next launch)', {
      error: err
    })
    trackMainError('app_identity', 'keychain_carry_over_failed', err)
  }
}
