import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSelectVault = vi.hoisted(() => vi.fn())

vi.mock('./index', () => ({
  selectVault: mockSelectVault
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

import { createVault, isValidVaultFolderName } from './create-vault'

describe('createVault', () => {
  let parent: string

  beforeEach(() => {
    vi.clearAllMocks()
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-create-vault-'))
    mockSelectVault.mockImplementation(async ({ path: vaultPath }: { path: string }) => ({
      success: true,
      vault: { path: vaultPath, name: path.basename(vaultPath) }
    }))
  })

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true })
  })

  it('creates <parent>/<name> and opens it', async () => {
    const result = await createVault({ parentPath: parent, name: '  Personal ' })

    const target = path.join(parent, 'Personal')
    expect(result.success).toBe(true)
    expect(fs.statSync(target).isDirectory()).toBe(true)
    expect(mockSelectVault).toHaveBeenCalledWith({ path: target })
  })

  it('creates a missing parent folder', async () => {
    const nestedParent = path.join(parent, 'Documents', 'Memry')
    const result = await createVault({ parentPath: nestedParent, name: 'Work' })

    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(nestedParent, 'Work'))).toBe(true)
  })

  it('refuses an existing folder instead of adopting it', async () => {
    fs.mkdirSync(path.join(parent, 'Work'))
    fs.writeFileSync(path.join(parent, 'Work', 'note.md'), '# keep me')

    const result = await createVault({ parentPath: parent, name: 'Work' })

    expect(result).toMatchObject({ success: false, errorCode: 'already-exists' })
    expect(mockSelectVault).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(parent, 'Work', 'note.md'), 'utf8')).toBe('# keep me')
  })

  it('rejects names that are not a single visible folder name', async () => {
    for (const name of ['../escape', 'a/b', 'a\\b', '.hidden', 'what?']) {
      const result = await createVault({ parentPath: parent, name })
      expect(result).toMatchObject({ success: false, errorCode: 'invalid-name' })
    }
    expect(mockSelectVault).not.toHaveBeenCalled()
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('removes the empty folder when the vault fails to open', async () => {
    mockSelectVault.mockResolvedValue({ success: false, vault: null, error: 'boom' })

    const result = await createVault({ parentPath: parent, name: 'Broken' })

    expect(result).toMatchObject({ success: false, error: 'boom' })
    expect(fs.existsSync(path.join(parent, 'Broken'))).toBe(false)
  })
})

describe('isValidVaultFolderName', () => {
  it('accepts ordinary names including spaces and unicode', () => {
    expect(isValidVaultFolderName('My Notes')).toBe(true)
    expect(isValidVaultFolderName('Notlarım')).toBe(true)
  })

  it('rejects empty, hidden, and separator-bearing names', () => {
    expect(isValidVaultFolderName('')).toBe(false)
    expect(isValidVaultFolderName('.memry')).toBe(false)
    expect(isValidVaultFolderName('a/b')).toBe(false)
  })
})
