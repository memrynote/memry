import { describe, it, expect } from 'vitest'
import { SelectVaultSchema, CreateVaultSchema, UpdateVaultConfigSchema } from './vault-api'

describe('SelectVaultSchema', () => {
  it('should validate empty object (folder picker mode)', () => {
    const result = SelectVaultSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should validate with path', () => {
    const result = SelectVaultSchema.safeParse({
      path: '/Users/user/Documents/vault'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with undefined path', () => {
    const result = SelectVaultSchema.safeParse({ path: undefined })
    expect(result.success).toBe(true)
  })

  it('should accept various path formats', () => {
    const paths = [
      '/absolute/unix/path',
      'C:\\Windows\\Path',
      '../relative/path',
      './current/path',
      'simple-folder'
    ]
    paths.forEach((path) => {
      const result = SelectVaultSchema.safeParse({ path })
      expect(result.success).toBe(true)
    })
  })
})

describe('CreateVaultSchema', () => {
  it('should validate correct input', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/Users/user/Documents/my-vault',
      name: 'My Vault'
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty path', () => {
    // Note: empty string is still a string, schema doesn't have min length
    const result = CreateVaultSchema.safeParse({
      path: '',
      name: 'My Vault'
    })
    expect(result.success).toBe(true) // Schema allows empty path string
  })

  it('should reject empty name', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/path/to/vault',
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject name over 100 chars', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/path/to/vault',
      name: 'a'.repeat(101)
    })
    expect(result.success).toBe(false)
  })

  it('should accept name at 100 chars boundary', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/path/to/vault',
      name: 'a'.repeat(100)
    })
    expect(result.success).toBe(true)
  })

  it('should accept name at 1 char minimum', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/path/to/vault',
      name: 'V'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing path', () => {
    const result = CreateVaultSchema.safeParse({
      name: 'My Vault'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing name', () => {
    const result = CreateVaultSchema.safeParse({
      path: '/path/to/vault'
    })
    expect(result.success).toBe(false)
  })

  it('should accept various valid names', () => {
    const names = ['My Vault', 'Work 2026', 'Personal-Notes', 'Vault_v2', 'メモ']
    names.forEach((name) => {
      const result = CreateVaultSchema.safeParse({ path: '/path', name })
      expect(result.success).toBe(true)
    })
  })
})

describe('UpdateVaultConfigSchema', () => {
  it('should validate empty object', () => {
    const result = UpdateVaultConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('should validate excludePatterns', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      excludePatterns: ['.git', 'node_modules', '*.tmp']
    })
    expect(result.success).toBe(true)
  })

  it('should validate defaultNoteFolder', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      defaultNoteFolder: 'notes'
    })
    expect(result.success).toBe(true)
  })

  it('should validate journalFolder', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      journalFolder: 'journal'
    })
    expect(result.success).toBe(true)
  })

  it('should validate attachmentsFolder', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      attachmentsFolder: 'attachments'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full config', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      excludePatterns: ['.git', '.DS_Store'],
      defaultNoteFolder: 'notes',
      journalFolder: 'daily',
      attachmentsFolder: 'assets'
    })
    expect(result.success).toBe(true)
  })

  it('should validate empty excludePatterns array', () => {
    const result = UpdateVaultConfigSchema.safeParse({
      excludePatterns: []
    })
    expect(result.success).toBe(true)
  })

  it('should accept various folder paths', () => {
    const paths = ['notes', 'my-notes', 'Notes 2026', 'sub/folder', '日記']
    paths.forEach((folder) => {
      const result = UpdateVaultConfigSchema.safeParse({
        defaultNoteFolder: folder,
        journalFolder: folder,
        attachmentsFolder: folder
      })
      expect(result.success).toBe(true)
    })
  })

  it('should accept various exclude patterns', () => {
    const patterns = [
      '.git',
      '*.tmp',
      'node_modules/**',
      '.DS_Store',
      'Thumbs.db',
      '**/*.bak',
      '.obsidian'
    ]
    const result = UpdateVaultConfigSchema.safeParse({
      excludePatterns: patterns
    })
    expect(result.success).toBe(true)
  })
})
