import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

import { getOrCreateInstallId, TELEMETRY_CONFIG_FILENAME } from './install-id'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('getOrCreateInstallId', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-telemetry-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a new UUID when no telemetry config file exists', () => {
    // #given a fresh userData directory
    expect(fs.existsSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME))).toBe(false)

    // #when retrieving the install id
    const id = getOrCreateInstallId()

    // #then a new UUID is created and persisted
    expect(id).toMatch(UUID_PATTERN)
    const configPath = path.join(tempDir, TELEMETRY_CONFIG_FILENAME)
    expect(fs.existsSync(configPath)).toBe(true)
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { installId: string }
    expect(stored.installId).toBe(id)
  })

  it('reuses the same UUID across multiple calls', () => {
    // #given a previously generated id
    const first = getOrCreateInstallId()

    // #when calling again
    const second = getOrCreateInstallId()
    const third = getOrCreateInstallId()

    // #then the value remains stable
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('reads an existing valid id from disk', () => {
    // #given a manually written telemetry config file
    const expected = '11111111-2222-3333-4444-555555555555'
    fs.writeFileSync(
      path.join(tempDir, TELEMETRY_CONFIG_FILENAME),
      JSON.stringify({ installId: expected })
    )

    // #when retrieving
    const id = getOrCreateInstallId()

    // #then the existing id is returned
    expect(id).toBe(expected)
  })

  it('replaces a corrupt config file with a fresh UUID', () => {
    // #given a corrupt JSON file
    fs.writeFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), '{"installId": ')

    // #when retrieving
    const id = getOrCreateInstallId()

    // #then a new UUID is created and persisted
    expect(id).toMatch(UUID_PATTERN)
    const stored = JSON.parse(
      fs.readFileSync(path.join(tempDir, TELEMETRY_CONFIG_FILENAME), 'utf-8')
    ) as { installId: string }
    expect(stored.installId).toBe(id)
  })

  it('replaces an invalid (non-UUID) installId with a fresh one', () => {
    // #given a config file with a non-UUID id
    fs.writeFileSync(
      path.join(tempDir, TELEMETRY_CONFIG_FILENAME),
      JSON.stringify({ installId: 'not-a-uuid' })
    )

    // #when retrieving
    const id = getOrCreateInstallId()

    // #then a new UUID replaces the invalid one
    expect(id).toMatch(UUID_PATTERN)
    expect(id).not.toBe('not-a-uuid')
  })

  it('uses Electron app.getPath("userData") to locate the config file', () => {
    // #given a fresh userData directory
    mockApp.getPath.mockClear()

    // #when retrieving
    getOrCreateInstallId()

    // #then app.getPath was queried with "userData"
    expect(mockApp.getPath).toHaveBeenCalledWith('userData')
  })
})
