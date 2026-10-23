import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const keytarStore = new Map<string, string>()
  return {
    encryptionAvailable: true,
    userDataDir: '',
    keytarStore,
    keytarGet: vi.fn(async () => null),
    keytarSet: vi.fn(async () => {}),
    keytarDelete: vi.fn(async () => true)
  }
})

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return harness.userDataDir
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => harness.encryptionAvailable,
    getSelectedStorageBackend: () => 'keychain_access',
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    // Stands in for Chromium's OSCrypt: a ciphertext written under a different
    // app identity carries a different prefix and simply fails to decrypt.
    decryptString: (buf: Buffer) => {
      const raw = buf.toString('utf-8')
      if (!raw.startsWith('enc:')) throw new Error('safeStorage decrypt failed')
      return raw.slice('enc:'.length)
    }
  }
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: harness.keytarGet,
    setPassword: harness.keytarSet,
    deletePassword: harness.keytarDelete
  }
}))

import {
  SECRET_STORE_FILENAME,
  probeSecretStoreIdentity,
  resetSecretStorageForTests
} from './secret-storage'
import { KEYCHAIN_ENTRIES } from '@memry/contracts/crypto'

/**
 * The app name decides which macOS Keychain item safeStorage uses, and a store's
 * location never proved which key encrypted it — v2026-08-06 physically moved a
 * legacy-keyed store into the renamed profile. Decrypting is the only exact
 * test, so this probe is what catches a wrong identity derivation.
 */
describe('probeSecretStoreIdentity', () => {
  const MASTER = KEYCHAIN_ENTRIES.MASTER_KEY

  const storePath = (): string => path.join(harness.userDataDir, SECRET_STORE_FILENAME)
  const seed = (entries: Record<string, Record<string, string>>): void => {
    fs.mkdirSync(harness.userDataDir, { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify({ version: 1, entries }), 'utf-8')
  }
  const readable = (v: string): string => Buffer.from(`enc:${v}`, 'utf-8').toString('base64')
  const wrongKey = (v: string): string => Buffer.from(`otherkey:${v}`, 'utf-8').toString('base64')

  beforeEach(() => {
    vi.clearAllMocks()
    resetSecretStorageForTests()
    harness.encryptionAvailable = true
    harness.keytarStore.clear()
    harness.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-probe-'))
  })

  afterEach(() => fs.rmSync(harness.userDataDir, { recursive: true, force: true }))

  it('inlines the same master-key identifiers the contract defines', () => {
    // secret-storage.ts inlines these to stay dependency-free on the earliest
    // startup path (it is bundled into the worker entries). Keep the copy honest.
    expect(MASTER).toEqual({ service: 'com.memry.sync', account: 'master-key' })
  })

  it('returns ok when the master-key ciphertext decrypts', () => {
    seed({
      [MASTER.service]: { [MASTER.account]: readable('bWFzdGVy'), 'access-token': readable('tok') }
    })
    expect(probeSecretStoreIdentity()).toBe('ok')
  })

  it('returns wrong-identity when the master key fails even though another entry decrypts', () => {
    // A mixed store: something re-written after a failed identity migration
    // reads fine while everything older does not. The master key must dominate —
    // it is the one secret that cannot be re-issued by signing in again.
    seed({
      [MASTER.service]: {
        [MASTER.account]: wrongKey('bWFzdGVy'),
        'refresh-token': readable('fresh')
      }
    })
    expect(probeSecretStoreIdentity()).toBe('wrong-identity')
  })

  it('falls back to any-entry readability when there is no master-key entry', () => {
    seed({ 'com.memry.calendar.google': { 'oauth-token': readable('tok') } })
    expect(probeSecretStoreIdentity()).toBe('ok')

    seed({ 'com.memry.calendar.google': { 'oauth-token': wrongKey('tok') } })
    expect(probeSecretStoreIdentity()).toBe('wrong-identity')
  })

  it('does not count a non-printable decrypt as readable', () => {
    // Chromium's macOS OSCrypt is unauthenticated AES-CBC, so the wrong key still
    // "succeeds" on PKCS#7 padding luck roughly 1 in 256 times. Every secret we
    // store is base64 or hex, so anything non-printable is garbage.
    seed({ [MASTER.service]: { [MASTER.account]: readable('bad\u0001value') } })
    expect(probeSecretStoreIdentity()).toBe('wrong-identity')
  })

  it('counts a plain printable decrypt as readable', () => {
    // Control for the case above: without it, that test would still pass if the
    // probe simply never returned 'ok'.
    seed({ [MASTER.service]: { [MASTER.account]: readable('cHJpbnRhYmxl') } })
    expect(probeSecretStoreIdentity()).toBe('ok')
  })

  it('returns unknown for a missing store, an empty store, or unavailable safeStorage', () => {
    expect(probeSecretStoreIdentity()).toBe('unknown')

    seed({})
    expect(probeSecretStoreIdentity()).toBe('unknown')

    seed({ [MASTER.service]: { [MASTER.account]: readable('m') } })
    harness.encryptionAvailable = false
    expect(probeSecretStoreIdentity()).toBe('unknown')
  })

  it('never moves an unparseable store aside', () => {
    // readStoreFile renames a corrupt store to *.corrupt-<ts> and returns empty,
    // which turns "unreadable" into "absent" and defeats the fail-loud guard that
    // is the only reason this incident did not destroy anything. A read-only
    // diagnostic must never reach that path.
    fs.mkdirSync(harness.userDataDir, { recursive: true })
    fs.writeFileSync(storePath(), 'definitely not json', 'utf-8')
    expect(probeSecretStoreIdentity()).toBe('unknown')
    expect(fs.readFileSync(storePath(), 'utf-8')).toBe('definitely not json')
    expect(fs.readdirSync(harness.userDataDir).filter((f) => f.includes('corrupt'))).toEqual([])
  })

  it('reads no keytar', () => {
    seed({ [MASTER.service]: { [MASTER.account]: wrongKey('m') } })
    probeSecretStoreIdentity()
    expect(harness.keytarGet).not.toHaveBeenCalled()
    expect(harness.keytarSet).not.toHaveBeenCalled()
    expect(harness.keytarDelete).not.toHaveBeenCalled()
  })
})
