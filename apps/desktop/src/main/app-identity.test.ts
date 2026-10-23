import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  symlinkSync,
  chmodSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const paths: Record<string, string | undefined> = {}
const setPathMock = vi.fn((key: string, value: string) => {
  paths[key] = value
})
const setNameMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => paths[key],
    setPath: (key: string, value: string) => {
      setPathMock(key, value)
    },
    setName: (name: string) => setNameMock(name),
    isReady: () => false
  },
  safeStorage: {}
}))

// The identity decision must never touch the OS keychain. These mocks exist so
// a regression that reintroduces keytar on this path is caught by an assertion
// rather than by a user losing access to their vault.
const getPasswordMock = vi.fn(async () => null)
const setPasswordMock = vi.fn(async () => {})
const deletePasswordMock = vi.fn(async () => true)

vi.mock('keytar', () => ({
  default: {
    getPassword: () => getPasswordMock(),
    setPassword: () => setPasswordMock(),
    deletePassword: () => deletePasswordMock()
  }
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

const trackMainErrorMock = vi.fn()
vi.mock('./telemetry/diagnostics', () => ({
  trackMainError: (...args: unknown[]) => trackMainErrorMock(...args)
}))

import {
  applyMemrynoteIdentity,
  flipIdentityPin,
  getIdentityDecision,
  resetIdentityDecisionForTests,
  safeStorageKeychainItem,
  IDENTITY_PIN_FILENAME,
  LEGACY_APP_NAME,
  MEMRYNOTE_APP_NAME
} from './app-identity'

const withPlatform = (platform: string, run: () => void): void => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
}

const STORE = 'secure-secrets.json'
const LOADED_STORE = '{"version":1,"entries":{"com.memry.sync":{"master-key":"v10cipher"}}}'

describe('applyMemrynoteIdentity', () => {
  let base: string
  let legacyDir: string
  let newDir: string
  let roDir: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetIdentityDecisionForTests()
    base = mkdtempSync(join(tmpdir(), 'memry-identity-'))
    legacyDir = join(base, '@memry', 'desktop')
    newDir = join(base, 'memrynote')
    roDir = null
    paths.appData = base
    paths.userData = legacyDir
  })

  afterEach(() => {
    if (roDir) {
      try {
        chmodSync(roDir, 0o700)
      } catch {
        /* best effort */
      }
    }
    rmSync(base, { recursive: true, force: true })
  })

  const run = (): void => {
    applyMemrynoteIdentity({ legacyDir, newDir })
  }
  const pinAt = (dir: string): { appName: string; flipped: boolean } =>
    JSON.parse(readFileSync(join(dir, IDENTITY_PIN_FILENAME), 'utf-8'))

  it('never touches the OS keychain while resolving the identity', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), LOADED_STORE)
    withPlatform('darwin', run)
    expect(getPasswordMock).not.toHaveBeenCalled()
    expect(setPasswordMock).not.toHaveBeenCalled()
    expect(deletePasswordMock).not.toHaveBeenCalled()
  })

  it('keeps the legacy app name when the store predates the rename', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), LOADED_STORE)
    writeFileSync(join(legacyDir, 'config.json'), '{"a":1}')
    withPlatform('darwin', run)
    // The name is what selects the Keychain item, so it must NOT change.
    expect(setNameMock).not.toHaveBeenCalled()
    // ...but the profile still moves to the clean path.
    expect(setPathMock).toHaveBeenCalledWith('userData', newDir)
    expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(lstatSync(legacyDir).isSymbolicLink()).toBe(true)
    expect(pinAt(newDir).appName).toBe(LEGACY_APP_NAME)
  })

  it('keeps the legacy app name for the cohort v2026-08-06 already migrated', () => {
    // The exact shipped-bug state: the store was moved into newDir by the broken
    // release, and the compatibility symlink it left behind is the evidence that
    // this profile predates the rename.
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, STORE), LOADED_STORE)
    mkdirSync(join(base, '@memry'), { recursive: true })
    symlinkSync(newDir, legacyDir, 'dir')
    withPlatform('darwin', run)
    expect(setNameMock).not.toHaveBeenCalled()
    expect(setPathMock).toHaveBeenCalledWith('userData', newDir)
    expect(pinAt(newDir).appName).toBe(LEGACY_APP_NAME)
  })

  it('FRESH INSTALL: a profile born under memrynote keeps the memrynote name', () => {
    // A blanket name revert would strand this cohort's entire store, which is
    // encrypted under the memrynote key.
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, STORE), LOADED_STORE)
    withPlatform('darwin', run)
    expect(setNameMock).toHaveBeenCalledWith(MEMRYNOTE_APP_NAME)
    expect(pinAt(newDir).appName).toBe(MEMRYNOTE_APP_NAME)
  })

  it('adopts memrynote on a genuinely fresh install with no store anywhere', () => {
    withPlatform('darwin', run)
    expect(setNameMock).toHaveBeenCalledWith(MEMRYNOTE_APP_NAME)
    expect(setPathMock).toHaveBeenCalledWith('userData', newDir)
    expect(pinAt(newDir).appName).toBe(MEMRYNOTE_APP_NAME)
  })

  it('an existing pin overrides the filesystem derivation', () => {
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, STORE), LOADED_STORE)
    mkdirSync(join(base, '@memry'), { recursive: true })
    symlinkSync(newDir, legacyDir, 'dir')
    writeFileSync(
      join(newDir, IDENTITY_PIN_FILENAME),
      JSON.stringify({ version: 1, appName: MEMRYNOTE_APP_NAME, flipped: true })
    )
    withPlatform('darwin', run)
    // Derivation alone would say legacy; the pin wins.
    expect(setNameMock).toHaveBeenCalledWith(MEMRYNOTE_APP_NAME)
    expect(getIdentityDecision()?.reason).toBe('pinned')
    expect(getIdentityDecision()?.flipped).toBe(true)
  })

  for (const platform of ['win32', 'linux']) {
    it(`${platform}: a newDir holding only logs is not an already-migrated profile`, () => {
      // migrateLegacyLogDir() creates <appData>/memrynote/logs unconditionally,
      // after the identity decision. Treating that as a migrated profile makes
      // the app boot into a log-only directory as if it were a wiped install.
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, 'config.json'), '{"a":1}')
      mkdirSync(join(newDir, 'logs'), { recursive: true })
      withPlatform(platform, run)
      expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"a":1}')
      expect(setPathMock).toHaveBeenCalledWith('userData', newDir)
    })
  }

  it('windows adopts memrynote even when a secret store exists', () => {
    // DPAPI is not keyed by app name; the key material travels inside userData.
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), LOADED_STORE)
    withPlatform('win32', run)
    expect(setNameMock).toHaveBeenCalledWith(MEMRYNOTE_APP_NAME)
    expect(pinAt(newDir).appName).toBe(MEMRYNOTE_APP_NAME)
  })

  it('linux keeps the legacy identity when a store exists', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), LOADED_STORE)
    withPlatform('linux', run)
    expect(setNameMock).not.toHaveBeenCalled()
    expect(setPathMock).not.toHaveBeenCalled()
  })

  it('linux with a store already in newDir keeps the legacy identity', () => {
    // The shipped guard computed store presence from the ACTIVE dir, not only
    // the legacy one. That semantic is preserved.
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, STORE), LOADED_STORE)
    withPlatform('linux', run)
    expect(setNameMock).not.toHaveBeenCalled()
    expect(setPathMock).not.toHaveBeenCalled()
  })

  it('renames on Linux when no safeStorage store exists', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'config.json'), '{"a":1}')
    withPlatform('linux', run)
    expect(readFileSync(join(newDir, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(setPathMock).toHaveBeenCalledWith('userData', newDir)
  })

  it('treats an unparseable store as loaded and never renames away from it', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), 'not json at all')
    withPlatform('darwin', run)
    expect(setNameMock).not.toHaveBeenCalled()
  })

  it('does not move the profile when the identity pin cannot be persisted', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, STORE), LOADED_STORE)
    writeFileSync(join(legacyDir, 'config.json'), '{"a":1}')
    chmodSync(legacyDir, 0o500)
    roDir = legacyDir
    withPlatform('darwin', run)
    expect(setPathMock).not.toHaveBeenCalled()
    expect(setNameMock).not.toHaveBeenCalled()
    expect(readFileSync(join(legacyDir, 'config.json'), 'utf8')).toBe('{"a":1}')
  })

  it('stays on the legacy identity when the move fails', () => {
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'config.json'), '{"a":1}')
    roDir = join(base, 'ro')
    mkdirSync(roDir)
    newDir = join(roDir, 'memrynote')
    chmodSync(roDir, 0o500)
    withPlatform('darwin', run)
    expect(setNameMock).not.toHaveBeenCalled()
    expect(setPathMock).not.toHaveBeenCalled()
    expect(readFileSync(join(legacyDir, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(trackMainErrorMock).toHaveBeenCalledWith(
      'app_identity',
      'userdata_rename_failed',
      expect.anything()
    )
  })

  it('leaves a custom userData dir alone and records no decision', () => {
    paths.userData = join(base, 'custom-e2e-dir')
    withPlatform('darwin', run)
    expect(setNameMock).not.toHaveBeenCalled()
    expect(setPathMock).not.toHaveBeenCalled()
    // null keeps the post-ready probe inert under the e2e harness.
    expect(getIdentityDecision()).toBeNull()
  })
})

describe('flipIdentityPin', () => {
  let base: string

  beforeEach(() => {
    vi.clearAllMocks()
    resetIdentityDecisionForTests()
    base = mkdtempSync(join(tmpdir(), 'memry-identity-flip-'))
    paths.appData = base
    paths.userData = join(base, '@memry', 'desktop')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('flips to the other identity once, and never a second time', () => {
    const legacyDir = join(base, '@memry', 'desktop')
    const newDir = join(base, 'memrynote')
    mkdirSync(newDir, { recursive: true })
    writeFileSync(join(newDir, STORE), LOADED_STORE)
    withPlatform('darwin', () => {
      applyMemrynoteIdentity({ legacyDir, newDir })
    })
    expect(getIdentityDecision()?.appName).toBe(MEMRYNOTE_APP_NAME)

    expect(flipIdentityPin()).toBe(true)
    expect(JSON.parse(readFileSync(join(newDir, IDENTITY_PIN_FILENAME), 'utf-8'))).toMatchObject({
      appName: LEGACY_APP_NAME,
      flipped: true
    })

    // Termination guarantee: one flip per install, ever.
    expect(flipIdentityPin()).toBe(false)
  })

  it('does nothing without a decision', () => {
    resetIdentityDecisionForTests()
    expect(flipIdentityPin()).toBe(false)
  })
})

describe('safeStorageKeychainItem', () => {
  it('appends the " Key" account suffix Chromium actually uses', () => {
    // The v2026-08-06 incident was this exact string: the carry-over looked up
    // the bare account, found nothing, and gave up silently. Matches
    // tests/e2e/utils/keychain-cleanup.ts.
    expect(safeStorageKeychainItem(LEGACY_APP_NAME)).toEqual({
      service: '@memry/desktop Safe Storage',
      account: '@memry/desktop Key',
      masAccount: '@memry/desktop App Store Key'
    })
    expect(safeStorageKeychainItem(MEMRYNOTE_APP_NAME)).toEqual({
      service: 'memrynote Safe Storage',
      account: 'memrynote Key',
      masAccount: 'memrynote App Store Key'
    })
  })
})
