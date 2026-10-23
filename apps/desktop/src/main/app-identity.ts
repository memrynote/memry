import { app } from 'electron'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './lib/logger'
import { SECRET_STORE_FILENAME } from './secrets/secret-storage'
// Runs before the telemetry runtime exists; trackMainError events are held in
// the early buffer (telemetry/track.ts) and shipped once the runtime installs.
import { trackMainError } from './telemetry/diagnostics'

const logger = createLogger('AppIdentity')

export const MEMRYNOTE_APP_NAME = 'memrynote'

/**
 * Electron's own init sets app.name from apps/desktop/package.json BEFORE this
 * module runs. Choosing the legacy identity means "do not override it", so this
 * string MUST stay byte-identical to that package.json `name`, and package.json
 * must never gain a `productName`. Guarded by app-identity-contract.test.ts.
 */
export const LEGACY_APP_NAME = '@memry/desktop'

export const IDENTITY_PIN_FILENAME = 'app-identity.json'

/**
 * Documentation + diagnostics only — nothing in this app ever reads or writes
 * the Safe Storage item. Chromium derives both names itself from app.getName().
 *
 * The ` Key` / ` App Store Key` account suffix comes from Electron's Chromium
 * patch feat_ensure_mas_builds_of_the_same_application_can_use_safestorage
 * (kAccountNameSuffix); Electron's own C++ sets only the service suffix. Same
 * convention as tests/e2e/utils/keychain-cleanup.ts.
 *
 * Getting this wrong is what caused the v2026-08-06 incident: the previous
 * carry-over looked up the bare account, found nothing, and silently gave up.
 */
export function safeStorageKeychainItem(appName: string): {
  service: string
  account: string
  masAccount: string
} {
  return {
    service: `${appName} Safe Storage`,
    account: `${appName} Key`,
    masAccount: `${appName} App Store Key`
  }
}

interface IdentityPin {
  version: 1
  appName: string
  flipped: boolean
}

export interface IdentityDecision {
  /** MEMRYNOTE_APP_NAME or LEGACY_APP_NAME. */
  appName: string
  profileDir: string
  pinPath: string
  /** The pin file was persisted and read back. */
  pinned: boolean
  /** A corrective flip has already been spent — never flip twice. */
  flipped: boolean
  /** Telemetry token describing which rule decided. */
  reason: string
}

let decision: IdentityDecision | null = null

/**
 * null when the production identity was never applied (dev profile, or an e2e
 * `--user-data-dir`). Callers that act on the decision must no-op in that case.
 */
export function getIdentityDecision(): IdentityDecision | null {
  return decision
}

/** Test-only: clear the module-level decision between cases. */
export function resetIdentityDecisionForTests(): void {
  decision = null
}

// lstat, never stat: a compatibility symlink must not count as a real directory
// (following it would re-migrate a directory onto itself).
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// On Windows and Linux the LOG directory is nested inside userData
// (lib/logger.ts), and migrateLegacyLogDir() creates it unconditionally at
// startup — after the identity decision. So a directory that merely EXISTS is
// not proof of a migrated profile; treating it as one makes the app boot into a
// log-only directory as if it were a wiped install.
const NON_PROFILE_ENTRIES = new Set(['logs', '.DS_Store', IDENTITY_PIN_FILENAME])

function isProfileDir(path: string): boolean {
  if (!isRealDir(path)) return false
  try {
    return readdirSync(path).some((entry) => !NON_PROFILE_ENTRIES.has(entry))
  } catch {
    return false
  }
}

/**
 * True when the secret store holds at least one ciphertext, i.e. this profile
 * has secrets that are encrypted under whichever app name was live when they
 * were written. An unreadable or unparseable store counts as loaded: we must
 * never rename away from a store we could not inspect.
 */
function storeHasCiphertexts(dir: string): boolean {
  const path = join(dir, SECRET_STORE_FILENAME)
  if (!existsSync(path)) return false
  try {
    const entries = (JSON.parse(readFileSync(path, 'utf-8')) as { entries?: unknown })?.entries
    if (!entries || typeof entries !== 'object') return false
    return Object.values(entries as Record<string, unknown>).some(
      (accounts) =>
        Boolean(accounts) &&
        typeof accounts === 'object' &&
        Object.keys(accounts as Record<string, unknown>).length > 0
    )
  } catch {
    return true
  }
}

/**
 * Move a profile directory to its new home.
 *
 * The fast path is an atomic same-volume rename. It is not always available:
 * on Windows and Linux migrateLegacyLogDir() creates `<appData>/memrynote/logs`
 * unconditionally, so the destination can already exist without being a profile,
 * and renameSync would fail with ENOTEMPTY. In that case entries are moved
 * across individually. Anything already present at the destination is newer and
 * is left alone, and the source is only removed once it is empty — a directory
 * that still holds files is never deleted.
 */
function moveProfileInto(from: string, to: string): void {
  if (!existsSync(to)) {
    renameSync(from, to)
    return
  }
  for (const entry of readdirSync(from)) {
    const target = join(to, entry)
    if (existsSync(target)) continue
    renameSync(join(from, entry), target)
  }
  try {
    rmdirSync(from)
  } catch (err) {
    logger.warn('Legacy userData directory still has contents; left in place', { error: err })
  }
}

function readPin(dir: string): IdentityPin | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, IDENTITY_PIN_FILENAME), 'utf-8')) as IdentityPin
    if (raw?.appName !== LEGACY_APP_NAME && raw?.appName !== MEMRYNOTE_APP_NAME) return null
    return { version: 1, appName: raw.appName, flipped: raw.flipped === true }
  } catch {
    return null
  }
}

/** Atomic tmp+rename, then read back — a pin that cannot be re-read is no pin. */
function writePin(dir: string, pin: IdentityPin): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, IDENTITY_PIN_FILENAME)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...pin, version: 1 }, null, 2), 'utf-8')
    renameSync(tmp, target)
    const readBack = readPin(dir)
    return readBack?.appName === pin.appName && readBack.flipped === pin.flipped
  } catch (err) {
    logger.warn('Could not persist the app identity pin', { error: err, dir })
    return false
  }
}

/**
 * Record that the derived identity was wrong, so the NEXT launch picks the other
 * one. Deliberately does not relaunch: a restart the user initiates is safer
 * than one the app forces during startup. Flips at most once, ever, which is
 * what guarantees this terminates.
 */
export function flipIdentityPin(): boolean {
  if (!decision || !decision.pinned || decision.flipped) return false
  const other = decision.appName === MEMRYNOTE_APP_NAME ? LEGACY_APP_NAME : MEMRYNOTE_APP_NAME
  const ok = writePin(decision.profileDir, { version: 1, appName: other, flipped: true })
  if (ok) {
    decision = { ...decision, flipped: true }
    logger.warn(
      'Secret store is unreadable under the current app identity; ' +
        'pinned the other identity for the next launch',
      { next: other }
    )
  }
  return ok
}

/**
 * Choose this install's runtime identity and move the profile to its final home.
 *
 * The app NAME and the DATA PATH are independent levers and are treated as such:
 *
 *  - PATH: userData always ends up at `<appData>/memrynote`, so the scoped
 *    package name stops leaking into a user-visible folder. A compatibility
 *    symlink stays at the legacy path so downgraded binaries and stored absolute
 *    paths keep resolving.
 *
 *  - NAME: on macOS the name alone decides which Keychain item Electron's
 *    safeStorage uses, so it decides whether an existing secret store can still
 *    be decrypted. An install whose store predates the rename keeps the legacy
 *    name permanently; only a profile that has no pre-rename secrets adopts
 *    `memrynote`. v2026-08-06 renamed unconditionally and stranded every
 *    pre-existing store behind a freshly minted key.
 *
 * Fully synchronous and touches ZERO keychain items — only Chromium ever reads
 * or writes its own Safe Storage entry. Every failure path keeps the legacy
 * identity for this launch and retries next time; the app never boots with an
 * empty profile. Dev profiles (MEMRY_DEVICE) never call this, and a custom
 * userData (e2e `--user-data-dir`) is left alone.
 */
export function applyMemrynoteIdentity(dirs?: { legacyDir?: string; newDir?: string }): void {
  try {
    const appData = app.getPath('appData')
    const legacyDir = dirs?.legacyDir ?? join(appData, '@memry', 'desktop')
    const newDir = dirs?.newDir ?? join(appData, MEMRYNOTE_APP_NAME)

    if (app.getPath('userData') !== legacyDir) return

    const migrated = isProfileDir(newDir)
    const sourceDir = migrated ? newDir : legacyDir
    const pin = readPin(sourceDir)

    // Linux keyrings key the safeStorage item by app name and keytar cannot
    // write Chromium's libsecret schema, so an install with a store keeps the
    // legacy identity outright — unchanged from the shipped behaviour.
    if (process.platform === 'linux' && storeHasCiphertexts(sourceDir)) {
      logger.warn('safeStorage store present on Linux; keeping the legacy app identity')
      return
    }

    let appName: string
    let reason: string
    if (pin) {
      appName = pin.appName
      reason = 'pinned'
    } else if (process.platform === 'win32') {
      // DPAPI is not keyed by app name; the key material travels inside userData.
      appName = MEMRYNOTE_APP_NAME
      reason = 'win32-dpapi'
    } else if (!storeHasCiphertexts(sourceDir)) {
      appName = MEMRYNOTE_APP_NAME
      reason = 'no-store'
    } else if (!migrated || isSymlink(legacyDir)) {
      // A store that sits in a not-yet-migrated profile, or in a migrated one
      // that left a compatibility symlink behind, was written before the rename
      // and is therefore encrypted under the legacy name's key.
      appName = LEGACY_APP_NAME
      reason = migrated ? 'store-migrated-from-legacy' : 'store-predates-rename'
    } else {
      // A profile born at the new path: its store was written under memrynote.
      appName = MEMRYNOTE_APP_NAME
      reason = 'store-born-under-memrynote'
    }

    const profileDir = newDir

    if (!migrated && isRealDir(legacyDir)) {
      // The pin has to survive the move: once the profile lives at newDir the
      // derivation above would no longer see the legacy evidence. Write it into
      // the directory that is about to be renamed so it travels with it, and
      // refuse to move at all if it will not stick.
      if (!writePin(legacyDir, { version: 1, appName, flipped: false })) {
        logger.error('Could not pin the app identity; keeping the legacy identity this launch')
        trackMainError('app_identity', 'identity_pin_failed', new Error(reason))
        return
      }
      try {
        moveProfileInto(legacyDir, newDir)
      } catch (err) {
        logger.error('Could not move legacy userData; keeping the legacy identity this launch', {
          error: err
        })
        trackMainError('app_identity', 'userdata_rename_failed', err)
        return
      }
      // Only when the legacy directory is actually gone — symlinking over a
      // directory that still holds files would hide them.
      if (!existsSync(legacyDir)) {
        try {
          symlinkSync(newDir, legacyDir, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (err) {
          logger.warn('Could not leave a compatibility symlink at the legacy userData path', {
            error: err
          })
        }
      }
    }

    const pinned = pin !== null || writePin(profileDir, { version: 1, appName, flipped: false })

    if (appName === MEMRYNOTE_APP_NAME) app.setName(MEMRYNOTE_APP_NAME)
    app.setPath('userData', profileDir)

    decision = {
      appName,
      profileDir,
      pinPath: join(profileDir, IDENTITY_PIN_FILENAME),
      pinned,
      flipped: pin?.flipped === true,
      reason
    }
    logger.info('Runtime identity resolved', { appName, reason, pinned })
  } catch (err) {
    try {
      logger.error('App identity migration failed; keeping the legacy identity', { error: err })
      trackMainError('app_identity', 'identity_migration_failed', err)
    } catch {
      /* logging must never break startup */
    }
  }
}
