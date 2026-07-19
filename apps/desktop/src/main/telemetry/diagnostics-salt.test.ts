import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

import { getOrCreateDiagnosticsSalt, makeSaltedHasher } from './diagnostics-salt'
import { TELEMETRY_CONFIG_FILENAME } from './config'

const SALT_PATTERN = /^[0-9a-f]{32}$/

describe('makeSaltedHasher', () => {
  it('is deterministic per salt and 10 hex chars', () => {
    const h = makeSaltedHasher('salt-A')
    expect(h('x')).toBe(h('x'))
    expect(h('x')).toMatch(/^[0-9a-f]{10}$/)
  })
  it('differs across salts (per-install privacy)', () => {
    expect(makeSaltedHasher('A')('x')).not.toBe(makeSaltedHasher('B')('x'))
  })
})

describe('getOrCreateDiagnosticsSalt', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-diag-salt-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const readStoredSalt = (): string | undefined => {
    const configPath = path.join(tempDir, TELEMETRY_CONFIG_FILENAME)
    if (!fs.existsSync(configPath)) return undefined
    return (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { diagnosticsSalt?: string })
      .diagnosticsSalt
  }

  it('generates a 32-hex salt and persists it on a fresh install', () => {
    // #given no telemetry config exists yet
    expect(fs.existsSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME))).toBe(false)

    // #when retrieving the salt
    const salt = getOrCreateDiagnosticsSalt()

    // #then a valid salt is returned AND persisted to disk
    expect(salt).toMatch(SALT_PATTERN)
    expect(readStoredSalt()).toBe(salt)
  })

  it('returns the same persisted salt across calls (stable per install)', () => {
    // #given a salt created on first call
    const first = getOrCreateDiagnosticsSalt()

    // #when calling again
    const second = getOrCreateDiagnosticsSalt()
    const third = getOrCreateDiagnosticsSalt()

    // #then the value never changes — the correlation contract holds
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('returns a stored valid salt as-is without rewriting it', () => {
    // #given a manually written valid salt
    const stored = 'abcdef0123456789abcdef0123456789'
    fs.writeFileSync(
      path.join(tempDir, TELEMETRY_CONFIG_FILENAME),
      JSON.stringify({ diagnosticsSalt: stored })
    )
    const before = fs.readFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), 'utf-8')

    // #when retrieving
    const salt = getOrCreateDiagnosticsSalt()

    // #then the existing salt is returned and the file is untouched (no regeneration/rewrite)
    expect(salt).toBe(stored)
    expect(fs.readFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), 'utf-8')).toBe(before)
  })

  it('regenerates a valid salt when the stored value is invalid', () => {
    // #given a corrupt/invalid stored salt
    fs.writeFileSync(
      path.join(tempDir, TELEMETRY_CONFIG_FILENAME),
      JSON.stringify({ diagnosticsSalt: 'xyz' })
    )

    // #when retrieving
    const salt = getOrCreateDiagnosticsSalt()

    // #then a fresh valid salt replaces it and is persisted
    expect(salt).toMatch(SALT_PATTERN)
    expect(salt).not.toBe('xyz')
    expect(readStoredSalt()).toBe(salt)
  })
})
