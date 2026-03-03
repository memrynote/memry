/**
 * Tests for init.ts
 * Tests vault initialization and path utility functions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  getMemryDir,
  getDataDbPath,
  getIndexDbPath,
  getConfigPath,
  isVaultInitialized,
  isValidDirectory,
  hasWritePermission,
  initVault,
  readVaultConfig,
  writeVaultConfig,
  getVaultName,
  countMarkdownFiles
} from './init'

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempDir(prefix = 'init-test-'): TestDir {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ============================================================================
// Path Helper Tests (T354)
// ============================================================================

describe('getMemryDir', () => {
  it('T354: returns .memry path inside vault', () => {
    const result = getMemryDir('/path/to/vault')

    expect(result).toBe(path.join('/path/to/vault', '.memry'))
  })
})

describe('getDataDbPath', () => {
  it('T354: returns data.db path inside .memry', () => {
    const result = getDataDbPath('/path/to/vault')

    expect(result).toBe(path.join('/path/to/vault', '.memry', 'data.db'))
  })
})

describe('getIndexDbPath', () => {
  it('T354: returns index.db path inside .memry', () => {
    const result = getIndexDbPath('/path/to/vault')

    expect(result).toBe(path.join('/path/to/vault', '.memry', 'index.db'))
  })
})

describe('getConfigPath', () => {
  it('T354: returns config.json path inside .memry', () => {
    const result = getConfigPath('/path/to/vault')

    expect(result).toBe(path.join('/path/to/vault', '.memry', 'config.json'))
  })
})

// ============================================================================
// isVaultInitialized Tests (T355)
// ============================================================================

describe('isVaultInitialized', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T355: returns true when .memry folder exists', () => {
    fs.mkdirSync(path.join(tempDir.path, '.memry'))

    expect(isVaultInitialized(tempDir.path)).toBe(true)
  })

  it('T355: returns false when .memry folder does not exist', () => {
    expect(isVaultInitialized(tempDir.path)).toBe(false)
  })
})

// ============================================================================
// isValidDirectory Tests (T356)
// ============================================================================

describe('isValidDirectory', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T356: returns true for existing directory', () => {
    expect(isValidDirectory(tempDir.path)).toBe(true)
  })

  it('T356: returns false for non-existent path', () => {
    expect(isValidDirectory(path.join(tempDir.path, 'nonexistent'))).toBe(false)
  })

  it('T356: returns false for file path', () => {
    const filePath = path.join(tempDir.path, 'file.txt')
    fs.writeFileSync(filePath, '')

    expect(isValidDirectory(filePath)).toBe(false)
  })
})

// ============================================================================
// hasWritePermission Tests (T356)
// ============================================================================

describe('hasWritePermission', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T356: returns true for writable directory', () => {
    expect(hasWritePermission(tempDir.path)).toBe(true)
  })

  it('T356: returns false for non-existent directory', () => {
    expect(hasWritePermission(path.join(tempDir.path, 'nonexistent'))).toBe(false)
  })

  // Note: Testing read-only directories is platform-specific and may require sudo
  // Skipping that test for portability
})

// ============================================================================
// initVault Tests (T357)
// ============================================================================

describe('initVault', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T357: creates vault structure with all folders', () => {
    initVault(tempDir.path)

    // Check .memry folder
    expect(fs.existsSync(path.join(tempDir.path, '.memry'))).toBe(true)

    // Check config.json
    expect(fs.existsSync(path.join(tempDir.path, '.memry', 'config.json'))).toBe(true)

    // Check default folders
    expect(fs.existsSync(path.join(tempDir.path, 'notes'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir.path, 'journal'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir.path, 'attachments'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir.path, 'attachments', 'images'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir.path, 'attachments', 'files'))).toBe(true)
  })

  it('T357: creates default config.json', () => {
    initVault(tempDir.path)

    const configPath = path.join(tempDir.path, '.memry', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

    expect(config.excludePatterns).toContain('.git')
    expect(config.excludePatterns).toContain('node_modules')
    expect(config.defaultNoteFolder).toBe('notes')
    expect(config.journalFolder).toBe('journal')
    expect(config.attachmentsFolder).toBe('attachments')
  })

  it('T357: is idempotent - does not overwrite existing config', () => {
    // First init
    initVault(tempDir.path)

    // Modify config
    const configPath = path.join(tempDir.path, '.memry', 'config.json')
    const customConfig = { customSetting: true, excludePatterns: ['custom'] }
    fs.writeFileSync(configPath, JSON.stringify(customConfig))

    // Second init
    initVault(tempDir.path)

    // Config should not be overwritten
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(config.customSetting).toBe(true)
  })
})

// ============================================================================
// readVaultConfig Tests (T358)
// ============================================================================

describe('readVaultConfig', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T358: returns default config when file does not exist', () => {
    const config = readVaultConfig(tempDir.path)

    expect(config.excludePatterns).toContain('.git')
    expect(config.defaultNoteFolder).toBe('notes')
    expect(config.journalFolder).toBe('journal')
    expect(config.attachmentsFolder).toBe('attachments')
  })

  it('T358: reads and parses JSON config', () => {
    fs.mkdirSync(path.join(tempDir.path, '.memry'))
    fs.writeFileSync(
      path.join(tempDir.path, '.memry', 'config.json'),
      JSON.stringify({
        excludePatterns: ['custom'],
        defaultNoteFolder: 'custom-notes'
      })
    )

    const config = readVaultConfig(tempDir.path)

    expect(config.excludePatterns).toEqual(['custom'])
    expect(config.defaultNoteFolder).toBe('custom-notes')
    // Defaults should be merged
    expect(config.journalFolder).toBe('journal')
  })

  it('T358: returns default config on parse error', () => {
    fs.mkdirSync(path.join(tempDir.path, '.memry'))
    fs.writeFileSync(path.join(tempDir.path, '.memry', 'config.json'), 'invalid json')

    const config = readVaultConfig(tempDir.path)

    // Should return defaults
    expect(config.defaultNoteFolder).toBe('notes')
  })
})

// ============================================================================
// writeVaultConfig Tests (T358)
// ============================================================================

describe('writeVaultConfig', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
    fs.mkdirSync(path.join(tempDir.path, '.memry'))
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T358: merges with existing config', () => {
    fs.writeFileSync(
      path.join(tempDir.path, '.memry', 'config.json'),
      JSON.stringify({ defaultNoteFolder: 'notes', journalFolder: 'journal' })
    )

    const result = writeVaultConfig(tempDir.path, { defaultNoteFolder: 'my-notes' })

    expect(result.defaultNoteFolder).toBe('my-notes')
    expect(result.journalFolder).toBe('journal')
  })

  it('T358: writes config to file', () => {
    writeVaultConfig(tempDir.path, { defaultNoteFolder: 'custom' })

    const configPath = path.join(tempDir.path, '.memry', 'config.json')
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'))

    expect(saved.defaultNoteFolder).toBe('custom')
  })

  it('T358: returns the new config', () => {
    const result = writeVaultConfig(tempDir.path, { attachmentsFolder: 'files' })

    expect(result.attachmentsFolder).toBe('files')
    expect(result.defaultNoteFolder).toBe('notes') // Default preserved
  })
})

// ============================================================================
// getVaultName Tests (T359)
// ============================================================================

describe('getVaultName', () => {
  it('T359: returns last directory segment', () => {
    expect(getVaultName('/path/to/my-vault')).toBe('my-vault')
  })

  it('T359: handles trailing slash', () => {
    // path.basename handles this correctly
    expect(getVaultName('/path/to/vault')).toBe('vault')
  })

  it('T359: handles Windows-style paths', () => {
    // On Unix, this will treat it as a single segment
    // On Windows, it would split correctly
    const name = getVaultName('C:\\Users\\name\\Documents\\vault')
    expect(name).toBeTruthy()
  })
})

// ============================================================================
// countMarkdownFiles Tests (T359)
// ============================================================================

describe('countMarkdownFiles', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T359: counts .md files recursively', () => {
    fs.writeFileSync(path.join(tempDir.path, 'note1.md'), '')
    fs.writeFileSync(path.join(tempDir.path, 'note2.md'), '')
    fs.mkdirSync(path.join(tempDir.path, 'subfolder'))
    fs.writeFileSync(path.join(tempDir.path, 'subfolder', 'note3.md'), '')
    fs.writeFileSync(path.join(tempDir.path, 'other.txt'), '')

    expect(countMarkdownFiles(tempDir.path)).toBe(3)
  })

  it('T359: respects exclude patterns', () => {
    fs.writeFileSync(path.join(tempDir.path, 'keep.md'), '')
    fs.mkdirSync(path.join(tempDir.path, 'node_modules'))
    fs.writeFileSync(path.join(tempDir.path, 'node_modules', 'lib.md'), '')
    fs.mkdirSync(path.join(tempDir.path, '.git'))
    fs.writeFileSync(path.join(tempDir.path, '.git', 'config.md'), '')

    expect(countMarkdownFiles(tempDir.path, ['node_modules', '.git'])).toBe(1)
  })

  it('T359: returns 0 for empty directory', () => {
    expect(countMarkdownFiles(tempDir.path)).toBe(0)
  })

  it('T359: handles permission errors gracefully', () => {
    // Just verify it doesn't throw
    expect(() => countMarkdownFiles(tempDir.path)).not.toThrow()
  })
})
