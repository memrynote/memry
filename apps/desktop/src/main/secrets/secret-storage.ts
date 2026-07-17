import fs from 'node:fs'
import path from 'node:path'

import { app, safeStorage } from 'electron'
import keytar from 'keytar'

import { createLogger } from '../lib/logger'

const logger = createLogger('SecretStorage')

export const SECRET_STORE_FILENAME = 'secure-secrets.json'

const STORE_VERSION = 1

interface SecretStoreFile {
  version: number
  /** service -> account -> base64-encoded safeStorage ciphertext */
  entries: Record<string, Record<string, string>>
}

export interface GetSecretOptions {
  /**
   * Keep the OS-keychain copy even after a verified safeStorage migration.
   * The vault master key uses this: its keytar copy is only deleted once the
   * caller has confirmed the retrieved key actually unlocks the vault
   * (see finalizeKeytarMigration and crypto/vault-key-state.ts).
   */
  deferKeytarDelete?: boolean
}

// Lazy keytar cleanup (crash-resume: ciphertext persisted but the keytar
// delete never ran) is attempted at most once per secret per process run.
const keytarCleanupAttempted = new Set<string>()

let loggedPlaintextBackend = false

// Shared probe for the async safeStorage API (os_crypt_async). Electron
// lazily initializes the async encryptor on the first call to
// isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync, so
// concurrent startup reads must all await one probe instead of each
// triggering initialization.
let asyncEncryptionProbe: Promise<boolean> | null = null

const cleanupKey = (service: string, account: string): string => `${service}\u0000${account}`

/** Test-only: reset per-run module state between test cases. */
export function resetSecretStorageForTests(): void {
  keytarCleanupAttempted.clear()
  loggedPlaintextBackend = false
  asyncEncryptionProbe = null
}

// ---------------------------------------------------------------------------
// Electron access. Every touch of `app` / `safeStorage` stays inside
// try/catch: unit tests mock 'electron' with partial shapes (accessing a
// missing export throws), and plain-node imports resolve both to undefined.
// ---------------------------------------------------------------------------

function isAppReady(): boolean {
  try {
    return Boolean(app && typeof app.isReady === 'function' && app.isReady())
  } catch {
    return false
  }
}

export function isSafeStorageAvailable(): boolean {
  // isEncryptionAvailable must only be evaluated after app 'ready' — before
  // then its result is meaningless (always false on Linux, undefined
  // behaviour elsewhere), so pre-ready callers stay on the keytar path.
  if (!isAppReady()) return false
  try {
    if (typeof safeStorage?.isEncryptionAvailable !== 'function') return false
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux') {
      const backend =
        typeof safeStorage.getSelectedStorageBackend === 'function'
          ? safeStorage.getSelectedStorageBackend()
          : 'unknown'
      if (backend === 'basic_text') {
        // Plaintext backend: migrating would silently downgrade security vs
        // the OS keyring keytar uses. Refuse; keytar stays authoritative.
        if (!loggedPlaintextBackend) {
          loggedPlaintextBackend = true
          logger.warn(
            'safeStorage uses the plaintext basic_text backend; refusing migration, secrets stay in the OS keychain'
          )
        }
        return false
      }
    }
    return true
  } catch (err) {
    logger.warn('safeStorage availability check failed; using OS keychain', { error: err })
    return false
  }
}

function resolveStoreFilePath(): string | null {
  if (!isAppReady()) return null
  try {
    return path.join(app.getPath('userData'), SECRET_STORE_FILENAME)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Store file I/O
// ---------------------------------------------------------------------------

function emptyStore(): SecretStoreFile {
  return { version: STORE_VERSION, entries: {} }
}

function readStoreFile(filePath: string): SecretStoreFile {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return emptyStore()
  }
  try {
    const parsed = JSON.parse(raw) as SecretStoreFile
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return { version: STORE_VERSION, entries: parsed.entries }
    }
  } catch (err) {
    // Preserve the bytes for forensics instead of clobbering them on the next
    // write; any secret still in the OS keychain remains readable via fallback.
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
    } catch {
      /* best effort */
    }
    logger.error('Secret store file unparseable; moved aside, starting empty', { error: err })
  }
  return emptyStore()
}

function writeStoreFile(filePath: string, store: SecretStoreFile): void {
  // Atomic: full write to a temp file in the same directory, then rename over
  // the target, so a crash mid-write can never truncate the live store.
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      /* best effort */
    }
    throw err
  }
}

function readCiphertext(filePath: string, service: string, account: string): string | null {
  const value = readStoreFile(filePath).entries[service]?.[account]
  return typeof value === 'string' ? value : null
}

function persistCiphertext(
  filePath: string,
  service: string,
  account: string,
  ciphertext: string
): void {
  const store = readStoreFile(filePath)
  store.entries[service] = { ...store.entries[service], [account]: ciphertext }
  writeStoreFile(filePath, store)
}

function removeCiphertext(filePath: string, service: string, account: string): void {
  const store = readStoreFile(filePath)
  const serviceSecrets = store.entries[service]
  if (!serviceSecrets || !(account in serviceSecrets)) return
  delete serviceSecrets[account]
  if (Object.keys(serviceSecrets).length === 0) delete store.entries[service]
  writeStoreFile(filePath, store)
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

// The async safeStorage API (os_crypt_async, Electron 43+) produces and
// accepts ciphertext byte-identical to the sync API, so switching between the
// two is purely behavioral: no store-format change, no re-encryption pass.
// The sync calls below are the deprecation-candidate fallback — removing them
// later is a matter of deleting the two `safeStorage.encryptString` /
// `safeStorage.decryptString` branches and this availability probe.

function isAsyncSafeStorageAvailable(): Promise<boolean> {
  if (asyncEncryptionProbe === null) {
    asyncEncryptionProbe = (async () => {
      try {
        if (
          typeof safeStorage?.isAsyncEncryptionAvailable !== 'function' ||
          typeof safeStorage.encryptStringAsync !== 'function' ||
          typeof safeStorage.decryptStringAsync !== 'function'
        ) {
          return false
        }
        return await safeStorage.isAsyncEncryptionAvailable()
      } catch (err) {
        logger.warn('safeStorage async availability probe failed; using sync API', { error: err })
        return false
      }
    })()
  }
  return asyncEncryptionProbe
}

async function encryptValue(value: string): Promise<string | null> {
  try {
    const encrypted = (await isAsyncSafeStorageAvailable())
      ? await safeStorage.encryptStringAsync(value)
      : safeStorage.encryptString(value)
    return encrypted.toString('base64')
  } catch (err) {
    logger.error('safeStorage encryption failed', { error: err })
    return null
  }
}

async function decryptValue(ciphertext: string): Promise<string | null> {
  try {
    const encrypted = Buffer.from(ciphertext, 'base64')
    if (await isAsyncSafeStorageAvailable()) {
      // shouldReEncrypt is deliberately ignored: honoring it would rewrite
      // ciphertext on read, and this store's write path already re-encrypts
      // every secret on setSecret. Reads must stay side-effect-free on disk.
      const { result } = await safeStorage.decryptStringAsync(encrypted)
      return result
    }
    return safeStorage.decryptString(encrypted)
  } catch (err) {
    logger.warn('safeStorage decryption failed', { error: err })
    return null
  }
}

// ---------------------------------------------------------------------------
// Public API — keytar-shaped (service + account), dual-read with lazy
// migrate-on-read. keytar stays a read-only fallback for at least one release.
// ---------------------------------------------------------------------------

export async function getSecret(
  service: string,
  account: string,
  options?: GetSecretOptions
): Promise<string | null> {
  const filePath = isSafeStorageAvailable() ? resolveStoreFilePath() : null

  if (filePath) {
    const ciphertext = readCiphertext(filePath, service, account)
    if (ciphertext !== null) {
      const value = await decryptValue(ciphertext)
      if (value !== null) {
        if (!options?.deferKeytarDelete) {
          // Crash-resume: a previous run may have persisted the ciphertext but
          // died before deleting the keytar copy. Fire-and-forget so a hung OS
          // keychain (headless e2e) can never block the read itself.
          void cleanupLegacyKeytarCopy(service, account, value)
        }
        return value
      }
      logger.warn('Stored secret ciphertext unreadable; falling back to OS keychain', {
        service,
        account
      })
    }
  }

  const legacy = await keytar.getPassword(service, account)
  if (legacy === null || filePath === null) return legacy

  await migrateLegacySecret(filePath, service, account, legacy, options?.deferKeytarDelete === true)
  return legacy
}

export async function setSecret(service: string, account: string, value: string): Promise<void> {
  const filePath = isSafeStorageAvailable() ? resolveStoreFilePath() : null

  if (filePath) {
    try {
      const ciphertext = await encryptValue(value)
      if (ciphertext === null || (await decryptValue(ciphertext)) !== value) {
        throw new Error('safeStorage round-trip verification failed')
      }
      persistCiphertext(filePath, service, account, ciphertext)
      const persisted = readCiphertext(filePath, service, account)
      if (persisted === null || (await decryptValue(persisted)) !== value) {
        throw new Error('persisted secret failed read-back verification')
      }
      // The safeStorage copy is now authoritative; drop any stale OS keychain
      // copy so the read fallback can never resurrect an outdated secret.
      try {
        await keytar.deletePassword(service, account)
      } catch (err) {
        logger.warn('Could not remove stale OS keychain copy after write', {
          error: err,
          service,
          account
        })
      }
      return
    } catch (err) {
      logger.error('safeStorage write failed; falling back to OS keychain', {
        error: err,
        service,
        account
      })
      try {
        removeCiphertext(filePath, service, account)
      } catch {
        /* best effort */
      }
    }
  }

  await keytar.setPassword(service, account, value)
}

export async function deleteSecret(service: string, account: string): Promise<void> {
  // Keytar first: it was the pre-migration source of truth and its errors are
  // what call sites historically surfaced.
  await keytar.deletePassword(service, account)
  // Store removal only needs the userData path, not encryption availability.
  const filePath = resolveStoreFilePath()
  if (filePath) removeCiphertext(filePath, service, account)
}

/**
 * Complete a deferred migration: delete the OS keychain copy of a secret whose
 * safeStorage copy has been externally confirmed (e.g. the vault master key
 * after it passed the vault verifier check). Idempotent and crash-resumable —
 * the keytar copy is only deleted while it is byte-identical to the decrypted
 * safeStorage copy.
 */
export async function finalizeKeytarMigration(service: string, account: string): Promise<void> {
  if (!isSafeStorageAvailable()) return
  const filePath = resolveStoreFilePath()
  if (!filePath) return
  try {
    const ciphertext = readCiphertext(filePath, service, account)
    if (ciphertext === null) return
    const value = await decryptValue(ciphertext)
    if (value === null) return
    const legacy = await keytar.getPassword(service, account)
    if (legacy !== null && legacy === value) {
      await keytar.deletePassword(service, account)
      logger.info('Removed confirmed migrated secret from OS keychain', { service, account })
    }
  } catch (err) {
    logger.warn('Deferred OS keychain cleanup failed (will retry next run)', {
      error: err,
      service,
      account
    })
  }
}

// ---------------------------------------------------------------------------
// Migration internals
// ---------------------------------------------------------------------------

async function migrateLegacySecret(
  filePath: string,
  service: string,
  account: string,
  value: string,
  deferKeytarDelete: boolean
): Promise<void> {
  try {
    const ciphertext = await encryptValue(value)
    if (ciphertext === null || (await decryptValue(ciphertext)) !== value) {
      logger.error(
        'safeStorage round-trip failed during migration; OS keychain stays authoritative',
        {
          service,
          account
        }
      )
      return
    }
    persistCiphertext(filePath, service, account, ciphertext)

    // Verify what actually hit the disk decrypts byte-identical to the source
    // before the keytar copy is ever touched.
    const persisted = readCiphertext(filePath, service, account)
    const roundTrip = persisted === null ? null : await decryptValue(persisted)
    if (roundTrip !== value) {
      logger.error('Persisted secret failed verification; OS keychain stays authoritative', {
        service,
        account
      })
      // Do not leave bad ciphertext shadowing the good keytar copy.
      try {
        removeCiphertext(filePath, service, account)
      } catch {
        /* best effort */
      }
      return
    }
  } catch (err) {
    logger.error('Secret migration failed; OS keychain stays authoritative', {
      error: err,
      service,
      account
    })
    try {
      removeCiphertext(filePath, service, account)
    } catch {
      /* best effort */
    }
    return
  }

  if (deferKeytarDelete) {
    logger.info('Migrated secret to safeStorage; OS keychain copy kept until confirmation', {
      service,
      account
    })
    return
  }

  try {
    await keytar.deletePassword(service, account)
    logger.info('Migrated secret from OS keychain to safeStorage', { service, account })
  } catch (err) {
    // The safeStorage copy is verified; a lingering keytar copy is harmless
    // and gets retried by the lazy cleanup on the next run.
    logger.warn('Could not delete migrated secret from OS keychain (will retry next run)', {
      error: err,
      service,
      account
    })
  }
}

async function cleanupLegacyKeytarCopy(
  service: string,
  account: string,
  expected: string
): Promise<void> {
  const key = cleanupKey(service, account)
  if (keytarCleanupAttempted.has(key)) return
  keytarCleanupAttempted.add(key)
  try {
    const legacy = await keytar.getPassword(service, account)
    if (legacy !== null && legacy === expected) {
      await keytar.deletePassword(service, account)
      logger.info('Removed migrated secret from OS keychain', { service, account })
    }
  } catch (err) {
    logger.warn('Legacy OS keychain cleanup failed (will retry next run)', {
      error: err,
      service,
      account
    })
  }
}
