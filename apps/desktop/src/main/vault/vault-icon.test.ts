import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readVaultIcon, writeVaultIcon } from './vault-icon'
import { readPreferences, writePreferences } from './vault-preferences'

describe('vault icon storage', () => {
  let vaultPath: string
  const configPath = (): string => path.join(vaultPath, '.memry', 'config.json')
  const readConfig = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(configPath(), 'utf-8'))

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-vault-icon-'))
    fs.mkdirSync(path.join(vaultPath, '.memry'))
  })

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true })
  })

  it('#given no config #then reads no icon', () => {
    expect(readVaultIcon(vaultPath)).toBeNull()
  })

  it('#given a config written before vault icons #then reads no icon', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ excludePatterns: [], preferences: {} }))
    expect(readVaultIcon(vaultPath)).toBeNull()
  })

  it('#when writing #then round-trips and keeps every other key', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ excludePatterns: ['.git'], preferences: { accentColor: '#ff0000' } })
    )
    const icon = { value: 'icon:Book01Icon', updatedAt: 42, pendingSync: true }

    writeVaultIcon(vaultPath, icon)

    expect(readVaultIcon(vaultPath)).toEqual(icon)
    expect(readConfig()).toMatchObject({
      excludePatterns: ['.git'],
      preferences: { accentColor: '#ff0000' }
    })
  })

  it('#given an icon #when preferences are written #then the icon survives', () => {
    writeVaultIcon(vaultPath, { value: '🌿', updatedAt: 1, pendingSync: false })

    writePreferences(vaultPath, { accentColor: '#00ff00' })

    expect(readVaultIcon(vaultPath)).toEqual({ value: '🌿', updatedAt: 1, pendingSync: false })
    expect(readPreferences(vaultPath).accentColor).toBe('#00ff00')
  })

  it('#given a reset #then reads a null value with its change time', () => {
    writeVaultIcon(vaultPath, { value: null, updatedAt: 7, pendingSync: true })
    expect(readVaultIcon(vaultPath)).toEqual({ value: null, updatedAt: 7, pendingSync: true })
  })

  it('#given a value this version cannot draw #then reads it as no icon, keeping the time', () => {
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ vaultIcon: { value: 'custom:abc', updatedAt: 9, pendingSync: false } })
    )
    expect(readVaultIcon(vaultPath)).toEqual({ value: null, updatedAt: 9, pendingSync: false })
  })

  it('#given a malformed entry #then reads no icon', () => {
    fs.writeFileSync(configPath(), JSON.stringify({ vaultIcon: { value: '🌿' } }))
    expect(readVaultIcon(vaultPath)).toBeNull()
  })
})
