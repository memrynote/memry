/**
 * Tests for file-ops.ts
 * Tests atomic file operations for safe reading and writing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { rename } from 'fs/promises'
import {
  atomicWrite,
  safeRead,
  readRequired,
  ensureDirectory,
  listMarkdownFiles,
  listDirectories,
  deleteFile,
  fileExists,
  directoryExists,
  getFileStats,
  sanitizeFilename,
  generateNotePath,
  generateUniquePath,
  generateUniquePathSync
} from './file-ops'
import { NoteError, NoteErrorCode } from '../lib/errors'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(actual.rename)
  }
})

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => loggerMock
}))

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempDir(prefix = 'file-ops-test-'): TestDir {
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
// atomicWrite Tests (T343-T344)
// ============================================================================

describe('atomicWrite', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T343: writes content via temp file and rename', async () => {
    const filePath = path.join(tempDir.path, 'test.txt')
    const content = 'Hello, world!'

    await atomicWrite(filePath, content)

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content)
  })

  it('T344: handles existing file by overwriting', async () => {
    const filePath = path.join(tempDir.path, 'existing.txt')
    fs.writeFileSync(filePath, 'Old content')

    await atomicWrite(filePath, 'New content')

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('New content')
  })

  it('creates parent directories if they do not exist', async () => {
    const filePath = path.join(tempDir.path, 'nested', 'deep', 'file.txt')

    await atomicWrite(filePath, 'Content')

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Content')
  })

  it('handles UTF-8 content correctly', async () => {
    const filePath = path.join(tempDir.path, 'unicode.txt')
    const content = '日本語テスト 🎉 émoji'

    await atomicWrite(filePath, content)

    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content)
  })

  it('cleans up temp file on write error', async () => {
    // Try to write to a directory path (will fail)
    const dirPath = path.join(tempDir.path, 'testdir')
    fs.mkdirSync(dirPath)

    await expect(atomicWrite(dirPath, 'content')).rejects.toThrow(NoteError)

    // No temp files should be left behind
    const files = fs.readdirSync(tempDir.path)
    const tempFiles = files.filter((f) => f.startsWith('.') && f.endsWith('.tmp'))
    expect(tempFiles).toHaveLength(0)
  })
})

// ============================================================================
// atomicWrite Transient Lock Retry Tests
// ============================================================================

describe('atomicWrite transient lock retry', () => {
  let tempDir: TestDir
  const renameMock = vi.mocked(rename)

  function errnoError(code: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: resource busy`) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  // Returns the NoteError atomicWrite rejected with, so tests can inspect the
  // cause/telemetry code rather than only asserting that it threw.
  async function atomicWriteError(filePath: string, content: string): Promise<NoteError> {
    try {
      await atomicWrite(filePath, content)
    } catch (error) {
      return error as NoteError
    }
    throw new Error('expected atomicWrite to reject')
  }

  beforeEach(() => {
    tempDir = createTempDir()
    renameMock.mockClear()
    loggerMock.warn.mockClear()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('retries rename on transient EBUSY and completes the write', async () => {
    const filePath = path.join(tempDir.path, 'locked.txt')
    renameMock.mockRejectedValueOnce(errnoError('EBUSY')).mockRejectedValueOnce(errnoError('EBUSY'))

    await atomicWrite(filePath, 'content after retry')

    expect(renameMock).toHaveBeenCalledTimes(3)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('content after retry')
  })

  it('logs each transient retry attempt with its errno, never the file path', async () => {
    // #given a vault file that is briefly locked (OneDrive/antivirus on Windows)
    const filePath = path.join(tempDir.path, 'logged.txt')
    renameMock.mockRejectedValueOnce(errnoError('EBUSY'))

    // #when the write succeeds on the retry
    await atomicWrite(filePath, 'content')

    // #then the local log explains the slow save: which errno, which attempt
    expect(loggerMock.warn).toHaveBeenCalledTimes(1)
    const logged = loggerMock.warn.mock.calls[0].join(' ')
    expect(logged).toContain('EBUSY')
    expect(logged).toContain('1')
    // #and the log line is about the operation, not the private path
    expect(logged).not.toContain(filePath)
  })

  it('propagates the error after exhausting retries on persistent EBUSY', async () => {
    const filePath = path.join(tempDir.path, 'always-locked.txt')
    renameMock
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockRejectedValueOnce(errnoError('EBUSY'))
      .mockRejectedValueOnce(errnoError('EBUSY'))

    const error = await atomicWriteError(filePath, 'never lands')

    expect(error).toBeInstanceOf(NoteError)
    expect(renameMock).toHaveBeenCalledTimes(4)
    expect(fs.existsSync(filePath)).toBe(false)

    const tempFiles = fs.readdirSync(tempDir.path).filter((f) => f.endsWith('.tmp'))
    expect(tempFiles).toHaveLength(0)

    // #then the errno survives all four attempts — otherwise a lock is
    // indistinguishable from a full disk in telemetry
    expect((error.cause as NodeJS.ErrnoException).code).toBe('EBUSY')
    expect(error.telemetryCode).toBe('NOTE_WRITE_FAILED:EBUSY')
  })

  it('does not retry non-retryable errors like ENOENT', async () => {
    const filePath = path.join(tempDir.path, 'missing-dir.txt')
    renameMock.mockRejectedValueOnce(errnoError('ENOENT'))

    await expect(atomicWrite(filePath, 'content')).rejects.toThrow(NoteError)

    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('preserves a non-transient ENOSPC cause instead of swallowing it', async () => {
    // #given a write that fails because the disk is full (not a lock)
    const filePath = path.join(tempDir.path, 'full-disk.txt')
    renameMock.mockRejectedValueOnce(errnoError('ENOSPC'))

    // #when the note save fails
    const error = await atomicWriteError(filePath, 'content')

    // #then the errno reaches the caller, so "disk full" is distinguishable
    // from "antivirus locked the file"
    expect(error).toBeInstanceOf(NoteError)
    expect(error.code).toBe(NoteErrorCode.WRITE_FAILED)
    expect((error.cause as NodeJS.ErrnoException).code).toBe('ENOSPC')
    // #and it fails fast rather than retrying an unrecoverable condition
    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('exposes a telemetry code with the errno and never the file path', async () => {
    // #given a write failure on a path that is private user data
    const filePath = path.join(tempDir.path, 'private-note.txt')
    renameMock.mockRejectedValueOnce(errnoError('ENOSPC'))

    // #when the resulting error is prepared for telemetry
    const error = await atomicWriteError(filePath, 'content')

    // #then the code identifies the failure precisely
    expect(error.telemetryCode).toBe('NOTE_WRITE_FAILED:ENOSPC')
    // #and carries nothing path-derived (privacy: paths must never be sent)
    expect(error.telemetryCode).not.toContain(filePath)
    expect(error.telemetryCode).not.toContain('private-note')
    expect(error.telemetryCode).not.toContain(path.sep)
    expect(error.telemetryCode).not.toContain(tempDir.path)
  })
})

// ============================================================================
// safeRead and readRequired Tests (T345)
// ============================================================================

describe('safeRead', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('preserves the originating errno as cause when read fails', async () => {
    // #given a path that exists but is not a readable file
    let error: NoteError | undefined

    // #when the read fails for a reason other than "missing"
    try {
      await safeRead(tempDir.path)
    } catch (err) {
      error = err as NoteError
    }

    // #then the errno survives for diagnosis, and the code names it
    expect(error).toBeInstanceOf(NoteError)
    expect(error?.code).toBe(NoteErrorCode.READ_FAILED)
    expect((error?.cause as NodeJS.ErrnoException).code).toBeTruthy()
    expect(error?.telemetryCode).toMatch(/^NOTE_READ_FAILED:[A-Z0-9]+$/)
  })

  it('T345: returns content for existing file', async () => {
    const filePath = path.join(tempDir.path, 'readable.txt')
    fs.writeFileSync(filePath, 'File content')

    const content = await safeRead(filePath)

    expect(content).toBe('File content')
  })

  it('T345: returns null for non-existent file', async () => {
    const filePath = path.join(tempDir.path, 'does-not-exist.txt')

    const content = await safeRead(filePath)

    expect(content).toBeNull()
  })

  it('handles empty files', async () => {
    const filePath = path.join(tempDir.path, 'empty.txt')
    fs.writeFileSync(filePath, '')

    const content = await safeRead(filePath)

    expect(content).toBe('')
  })
})

describe('readRequired', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T345: returns content for existing file', async () => {
    const filePath = path.join(tempDir.path, 'required.txt')
    fs.writeFileSync(filePath, 'Required content')

    const content = await readRequired(filePath)

    expect(content).toBe('Required content')
  })

  it('T345: throws NoteError for non-existent file', async () => {
    const filePath = path.join(tempDir.path, 'missing.txt')

    await expect(readRequired(filePath)).rejects.toThrow(NoteError)
  })
})

// ============================================================================
// ensureDirectory Tests (T346)
// ============================================================================

describe('ensureDirectory', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T346: creates directory recursively', async () => {
    const nestedPath = path.join(tempDir.path, 'a', 'b', 'c')

    await ensureDirectory(nestedPath)

    expect(fs.existsSync(nestedPath)).toBe(true)
    expect(fs.statSync(nestedPath).isDirectory()).toBe(true)
  })

  it('T346: succeeds if directory already exists', async () => {
    const existingDir = path.join(tempDir.path, 'existing')
    fs.mkdirSync(existingDir)

    await expect(ensureDirectory(existingDir)).resolves.not.toThrow()
    expect(fs.existsSync(existingDir)).toBe(true)
  })
})

// ============================================================================
// listMarkdownFiles Tests (T347)
// ============================================================================

describe('listMarkdownFiles', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T347: discovers .md files recursively', async () => {
    // Create test structure
    fs.writeFileSync(path.join(tempDir.path, 'note1.md'), '')
    fs.mkdirSync(path.join(tempDir.path, 'subfolder'))
    fs.writeFileSync(path.join(tempDir.path, 'subfolder', 'note2.md'), '')
    fs.writeFileSync(path.join(tempDir.path, 'other.txt'), '')

    const files = await listMarkdownFiles(tempDir.path)

    expect(files).toHaveLength(2)
    expect(files).toContain(path.join(tempDir.path, 'note1.md'))
    expect(files).toContain(path.join(tempDir.path, 'subfolder', 'note2.md'))
  })

  it('T347: skips hidden files and directories', async () => {
    fs.writeFileSync(path.join(tempDir.path, '.hidden.md'), '')
    fs.mkdirSync(path.join(tempDir.path, '.hiddendir'))
    fs.writeFileSync(path.join(tempDir.path, '.hiddendir', 'note.md'), '')
    fs.writeFileSync(path.join(tempDir.path, 'visible.md'), '')

    const files = await listMarkdownFiles(tempDir.path)

    expect(files).toHaveLength(1)
    expect(files[0]).toBe(path.join(tempDir.path, 'visible.md'))
  })

  it('returns relative paths when relativeTo is specified', async () => {
    fs.mkdirSync(path.join(tempDir.path, 'notes'))
    fs.writeFileSync(path.join(tempDir.path, 'notes', 'test.md'), '')

    const files = await listMarkdownFiles(tempDir.path, tempDir.path)

    expect(files).toContain('notes/test.md')
  })

  it('returns empty array for non-existent directory', async () => {
    const files = await listMarkdownFiles(path.join(tempDir.path, 'nonexistent'))

    expect(files).toEqual([])
  })
})

// ============================================================================
// listDirectories Tests (T348)
// ============================================================================

describe('listDirectories', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T348: lists subdirectories recursively', async () => {
    fs.mkdirSync(path.join(tempDir.path, 'folder1'))
    fs.mkdirSync(path.join(tempDir.path, 'folder1', 'subfolder'))
    fs.mkdirSync(path.join(tempDir.path, 'folder2'))
    fs.writeFileSync(path.join(tempDir.path, 'file.txt'), '')

    const dirs = await listDirectories(tempDir.path)

    expect(dirs).toHaveLength(3)
    expect(dirs).toContain(path.join(tempDir.path, 'folder1'))
    expect(dirs).toContain(path.join(tempDir.path, 'folder1', 'subfolder'))
    expect(dirs).toContain(path.join(tempDir.path, 'folder2'))
  })

  it('T348: skips hidden directories', async () => {
    fs.mkdirSync(path.join(tempDir.path, '.hidden'))
    fs.mkdirSync(path.join(tempDir.path, 'visible'))

    const dirs = await listDirectories(tempDir.path)

    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toBe(path.join(tempDir.path, 'visible'))
  })

  it('returns relative paths when relativeTo is specified', async () => {
    fs.mkdirSync(path.join(tempDir.path, 'projects'))

    const dirs = await listDirectories(tempDir.path, tempDir.path)

    expect(dirs).toContain('projects')
  })
})

// ============================================================================
// deleteFile Tests (T349)
// ============================================================================

describe('deleteFile', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T349: deletes existing file', async () => {
    const filePath = path.join(tempDir.path, 'deleteme.txt')
    fs.writeFileSync(filePath, 'content')

    await deleteFile(filePath)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('preserves the originating errno as cause when delete fails', async () => {
    // #given a path that exists but cannot be unlinked (it is a directory)
    const dirPath = path.join(tempDir.path, 'a-directory')
    fs.mkdirSync(dirPath)

    // #when the delete fails
    let error: NoteError | undefined
    try {
      await deleteFile(dirPath)
    } catch (err) {
      error = err as NoteError
    }

    // #then the errno survives for diagnosis, and the code names it
    expect(error).toBeInstanceOf(NoteError)
    expect(error?.code).toBe(NoteErrorCode.DELETE_FAILED)
    expect((error?.cause as NodeJS.ErrnoException).code).toBeTruthy()
    expect(error?.telemetryCode).toMatch(/^NOTE_DELETE_FAILED:[A-Z0-9]+$/)
  })

  it('T349: does not throw for non-existent file', async () => {
    const filePath = path.join(tempDir.path, 'nonexistent.txt')

    await expect(deleteFile(filePath)).resolves.not.toThrow()
  })
})

// ============================================================================
// fileExists and directoryExists Tests (T349)
// ============================================================================

describe('fileExists', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T349: returns true for existing file', async () => {
    const filePath = path.join(tempDir.path, 'exists.txt')
    fs.writeFileSync(filePath, '')

    expect(await fileExists(filePath)).toBe(true)
  })

  it('T349: returns false for non-existent file', async () => {
    expect(await fileExists(path.join(tempDir.path, 'nope.txt'))).toBe(false)
  })

  it('returns false for directories', async () => {
    const dirPath = path.join(tempDir.path, 'adir')
    fs.mkdirSync(dirPath)

    expect(await fileExists(dirPath)).toBe(false)
  })
})

describe('directoryExists', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T349: returns true for existing directory', async () => {
    const dirPath = path.join(tempDir.path, 'existingdir')
    fs.mkdirSync(dirPath)

    expect(await directoryExists(dirPath)).toBe(true)
  })

  it('T349: returns false for non-existent directory', async () => {
    expect(await directoryExists(path.join(tempDir.path, 'nope'))).toBe(false)
  })

  it('returns false for files', async () => {
    const filePath = path.join(tempDir.path, 'file.txt')
    fs.writeFileSync(filePath, '')

    expect(await directoryExists(filePath)).toBe(false)
  })
})

// ============================================================================
// getFileStats Tests (T349)
// ============================================================================

describe('getFileStats', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T349: returns size and timestamps for existing file', async () => {
    const filePath = path.join(tempDir.path, 'stats.txt')
    fs.writeFileSync(filePath, 'Hello, world!')

    const stats = await getFileStats(filePath)

    expect(stats).not.toBeNull()
    expect(stats!.size).toBe(13)
    expect(stats!.createdAt).toBeInstanceOf(Date)
    expect(stats!.modifiedAt).toBeInstanceOf(Date)
  })

  it('T349: returns null for non-existent file', async () => {
    const stats = await getFileStats(path.join(tempDir.path, 'nope.txt'))

    expect(stats).toBeNull()
  })
})

// ============================================================================
// sanitizeFilename Tests (T350)
// ============================================================================

describe('sanitizeFilename', () => {
  it('T350: removes invalid characters', () => {
    expect(sanitizeFilename('file<>:"/\\|?*.txt')).toBe('file.txt')
  })

  it('T350: collapses whitespace', () => {
    expect(sanitizeFilename('file   name   here')).toBe('file name here')
  })

  it('T350: trims whitespace', () => {
    expect(sanitizeFilename('  spaced  ')).toBe('spaced')
  })

  it('T350: removes leading dots (hidden files)', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden')
  })

  it('T350: returns "untitled" for empty input', () => {
    expect(sanitizeFilename('')).toBe('untitled')
    expect(sanitizeFilename('???')).toBe('untitled')
  })

  it('T350: strips all leading dots and rejects bare dot names', () => {
    // Loops the dot-strip so nothing collapses to a `.`/`..` fs reference.
    expect(sanitizeFilename('...')).toBe('untitled')
    expect(sanitizeFilename('..')).toBe('untitled')
    expect(sanitizeFilename('.hidden')).toBe('hidden')
  })

  it('T350: truncates to 200 characters', () => {
    const longName = 'a'.repeat(300)
    expect(sanitizeFilename(longName).length).toBe(200)
  })

  it('preserves valid characters', () => {
    expect(sanitizeFilename('My Note 2024')).toBe('My Note 2024')
    expect(sanitizeFilename('note-with_special.chars')).toBe('note-with_special.chars')
  })

  it('T350: strips Obsidian-forbidden characters [ ] # ^', () => {
    expect(sanitizeFilename('Draft [v2] #1')).toBe('Draft v2 1')
    expect(sanitizeFilename('a^b|c')).toBe('abc')
    expect(sanitizeFilename('[#^]')).toBe('untitled')
  })

  it('T350: bracket-stripping never yields a dot-traversal or leading-space name', () => {
    // Widened set can leave dots/spaces once brackets go; guard must clean up.
    expect(sanitizeFilename('[...]')).toBe('untitled')
    expect(sanitizeFilename('[..]')).toBe('untitled')
    expect(sanitizeFilename('#. Report')).toBe('Report')
  })
})

// ============================================================================
// generateNotePath Tests (T351)
// ============================================================================

describe('generateNotePath', () => {
  it('T351: generates path with sanitized title', () => {
    const result = generateNotePath('/vault/notes', 'My Note')

    expect(result).toBe(path.join('/vault/notes', 'My Note.md'))
  })

  it('T351: includes folder when specified', () => {
    const result = generateNotePath('/vault/notes', 'My Note', 'projects')

    expect(result).toBe(path.join('/vault/notes', 'projects', 'My Note.md'))
  })

  it('T351: sanitizes title for path safety', () => {
    const result = generateNotePath('/vault/notes', 'Note: With "Special" <Chars>')

    expect(result).toBe(path.join('/vault/notes', 'Note With Special Chars.md'))
  })
})

// ============================================================================
// generateUniquePath Tests (T352)
// ============================================================================

describe('generateUniquePath', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('T352: returns original path if file does not exist', async () => {
    const filePath = path.join(tempDir.path, 'unique.md')

    const result = await generateUniquePath(filePath)

    expect(result).toBe(filePath)
  })

  it('T352: adds counter suffix for collision handling', async () => {
    const filePath = path.join(tempDir.path, 'note.md')
    fs.writeFileSync(filePath, '')

    const result = await generateUniquePath(filePath)

    expect(result).toBe(path.join(tempDir.path, 'note 1.md'))
  })

  it('T352: increments counter until unique', async () => {
    const basePath = path.join(tempDir.path, 'note.md')
    fs.writeFileSync(basePath, '')
    fs.writeFileSync(path.join(tempDir.path, 'note 1.md'), '')
    fs.writeFileSync(path.join(tempDir.path, 'note 2.md'), '')

    const result = await generateUniquePath(basePath)

    expect(result).toBe(path.join(tempDir.path, 'note 3.md'))
  })

  it('preserves file extension correctly', async () => {
    const filePath = path.join(tempDir.path, 'document.txt')
    fs.writeFileSync(filePath, '')

    const result = await generateUniquePath(filePath)

    expect(result).toBe(path.join(tempDir.path, 'document 1.txt'))
  })
})

describe('generateUniquePathSync', () => {
  let tempDir: TestDir

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
  })

  it('returns basePath when nothing conflicts', () => {
    // #given
    const filePath = path.join(tempDir.path, 'unique.md')

    // #when
    const result = generateUniquePathSync(filePath)

    // #then
    expect(result).toBe(filePath)
  })

  it('appends " 1" when basePath exists on disk', () => {
    // #given
    const filePath = path.join(tempDir.path, 'note.md')
    fs.writeFileSync(filePath, '')

    // #when
    const result = generateUniquePathSync(filePath)

    // #then
    expect(result).toBe(path.join(tempDir.path, 'note 1.md'))
  })

  it('appends " 1" when isPathTaken returns true (DB collision)', () => {
    // #given
    const filePath = path.join(tempDir.path, 'note.md')
    const isPathTaken = (p: string) => p === filePath

    // #when
    const result = generateUniquePathSync(filePath, isPathTaken)

    // #then
    expect(result).toBe(path.join(tempDir.path, 'note 1.md'))
  })

  it('increments counter when both disk and DB paths are taken', () => {
    // #given
    const basePath = path.join(tempDir.path, 'note.md')
    fs.writeFileSync(basePath, '')
    fs.writeFileSync(path.join(tempDir.path, 'note 1.md'), '')
    const isPathTaken = (p: string) => p === path.join(tempDir.path, 'note 2.md')

    // #when
    const result = generateUniquePathSync(basePath, isPathTaken)

    // #then
    expect(result).toBe(path.join(tempDir.path, 'note 3.md'))
  })
})
