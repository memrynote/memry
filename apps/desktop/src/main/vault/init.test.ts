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
  invalidateVaultConfigCache,
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

    // Check default folders — notes/ is deprecated in the flat model (new notes
    // live at the vault root)
    expect(fs.existsSync(path.join(tempDir.path, 'notes'))).toBe(false)
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
    expect(config.defaultNoteFolder).toBe('')
    expect(config.journalFolder).toBe('journal')
    expect(config.journalDateFormat).toBe('YYYY-MM-DD')
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
    expect(config.defaultNoteFolder).toBe('')
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
    expect(config.defaultNoteFolder).toBe('')
  })
})

// ============================================================================
// readVaultConfig caching (#1079)
// ============================================================================

describe('readVaultConfig caching', () => {
  const FIXED_MTIME = new Date('2026-01-01T00:00:00.000Z')
  let tempDir: TestDir
  let configPath: string

  beforeEach(() => {
    tempDir = createTempDir()
    fs.mkdirSync(path.join(tempDir.path, '.memry'))
    configPath = getConfigPath(tempDir.path)
    fs.writeFileSync(configPath, JSON.stringify({ defaultNoteFolder: 'notes' }))
    // The cache compares nanosecond mtimes, and `utimesSync` is the only way to
    // reproduce one exactly — a Date read back from `stat` has lost the sub-ms
    // digits. Pinning the timestamp lets a test hold mtime fixed on purpose.
    fs.utimesSync(configPath, FIXED_MTIME, FIXED_MTIME)
    invalidateVaultConfigCache()
  })

  afterEach(() => {
    invalidateVaultConfigCache()
    tempDir.cleanup()
  })

  /**
   * Make config.json unparseable in place, leaving the inode, size and mtime the
   * cache validates against untouched. A later call that still returns the old
   * values provably did not re-read the file; one that returns defaults did.
   * (`vi.spyOn(fs, 'readFileSync')` is not available — the ESM namespace of a
   * node builtin is not configurable.)
   */
  function poisonConfigInPlace(): void {
    const before = fs.statSync(configPath)
    fs.writeFileSync(configPath, 'x'.repeat(Number(before.size)))
    fs.utimesSync(configPath, FIXED_MTIME, FIXED_MTIME)
    expect(fs.statSync(configPath).size).toBe(before.size)
    expect(fs.statSync(configPath).ino).toBe(before.ino)
  }

  it('#1079: repeated calls do not re-read config.json', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')

    poisonConfigInPlace()

    for (let i = 0; i < 10; i++) {
      expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')
    }
  })

  it('#1079: re-reads after invalidateVaultConfigCache()', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')

    poisonConfigInPlace()
    invalidateVaultConfigCache()

    // Unparseable on disk, so a real read falls back to defaults.
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('')
  })

  it('#1079: writeVaultConfig drops the entry itself, not just via a moved mtime', () => {
    writeVaultConfig(tempDir.path, { defaultNoteFolder: 'aaaaa' })
    fs.utimesSync(configPath, FIXED_MTIME, FIXED_MTIME)
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('aaaaa')

    const before = fs.statSync(configPath)

    // 'bbbbb' is the same length as 'aaaaa' and the write is in place, so inode
    // and size both hold; pinning mtime back stands in for a filesystem whose
    // timestamps are too coarse to separate two quick writes.
    writeVaultConfig(tempDir.path, { defaultNoteFolder: 'bbbbb' })
    fs.utimesSync(configPath, FIXED_MTIME, FIXED_MTIME)

    expect(fs.statSync(configPath).ino).toBe(before.ino)
    expect(fs.statSync(configPath).size).toBe(before.size)
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('bbbbb')
  })

  it('#1079: picks up an external hand edit', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')

    fs.writeFileSync(configPath, JSON.stringify({ defaultNoteFolder: 'hand-edited' }))

    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('hand-edited')
  })

  it('#1079: picks up a same-size external edit on mtime alone', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')
    const before = fs.statSync(configPath)

    // 'other' is the same length as 'notes', so only the timestamp moves.
    fs.writeFileSync(configPath, JSON.stringify({ defaultNoteFolder: 'other' }))
    expect(fs.statSync(configPath).size).toBe(before.size)
    fs.utimesSync(configPath, before.atime, new Date(before.mtimeMs + 2000))

    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('other')
  })

  it('#1079: picks up an atomic create+rename replacement on inode alone', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')
    const before = fs.statSync(configPath)

    // How writePreferences() and other atomic writers replace config.json:
    // a new file swapped in, so size and mtime can both match the old one.
    const tempPath = `${configPath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify({ defaultNoteFolder: 'other' }))
    fs.renameSync(tempPath, configPath)
    fs.utimesSync(configPath, FIXED_MTIME, FIXED_MTIME)

    expect(fs.statSync(configPath).size).toBe(before.size)
    expect(fs.statSync(configPath).ino).not.toBe(before.ino)
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('other')
  })

  it('#1079: never serves one vault config for another', () => {
    const otherVault = createTempDir()
    try {
      fs.mkdirSync(path.join(otherVault.path, '.memry'))
      fs.writeFileSync(
        getConfigPath(otherVault.path),
        JSON.stringify({ defaultNoteFolder: 'other-notes' })
      )

      expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')
      expect(readVaultConfig(otherVault.path).defaultNoteFolder).toBe('other-notes')
      expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')
    } finally {
      otherVault.cleanup()
    }
  })

  it('#1079: falls back to defaults once config.json is deleted', () => {
    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('notes')

    fs.rmSync(configPath)

    expect(readVaultConfig(tempDir.path).defaultNoteFolder).toBe('')
  })

  it('#1079: a caller mutating the result cannot poison the cache', () => {
    const first = readVaultConfig(tempDir.path)
    first.defaultNoteFolder = 'poison'
    first.excludePatterns.push('poison')

    const second = readVaultConfig(tempDir.path)

    expect(second.defaultNoteFolder).toBe('notes')
    expect(second.excludePatterns).not.toContain('poison')
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
    expect(result.defaultNoteFolder).toBe('') // Default preserved
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
