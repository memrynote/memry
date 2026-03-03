/**
 * Tests for journal.ts
 * Tests journal file operations including parsing, serialization, and CRUD.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  parseJournalEntry,
  serializeJournalEntry,
  createJournalFrontmatter,
  readJournalEntry,
  writeJournalEntry,
  deleteJournalEntryFile,
  journalEntryExists,
  getJournalPath,
  calculateActivityLevelFromContent,
  extractPreview,
  extractJournalProperties
} from './journal'

// ============================================================================
// Mock Setup
// ============================================================================

// Mock the vault/index module for functions that need vault state
vi.mock('./index', () => ({
  getStatus: vi.fn(() => ({ path: '/mock/vault', isOpen: true })),
  getConfig: vi.fn(() => ({
    journalFolder: 'journal',
    defaultNoteFolder: 'notes',
    attachmentsFolder: 'attachments',
    excludePatterns: []
  }))
}))

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempVault(prefix = 'journal-test-'): TestDir {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Create journal folder
  fs.mkdirSync(path.join(tempPath, 'journal'), { recursive: true })
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

const FIXED_ISO = '2026-01-15T12:00:00.000Z'

// ============================================================================
// getJournalPath Tests (T378)
// ============================================================================

describe('getJournalPath', () => {
  it('T378: generates date-based path', () => {
    // With the mock, this should return a path in /mock/vault/journal/
    const result = getJournalPath('2026-01-15')

    expect(result).toContain('journal')
    expect(result).toContain('2026-01-15.md')
  })
})

// ============================================================================
// parseJournalEntry Tests (T379)
// ============================================================================

describe('parseJournalEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('T379: extracts YAML frontmatter and content', () => {
    const raw = `---
id: j2026-01-15
date: 2026-01-15
created: 2026-01-15T08:00:00.000Z
modified: 2026-01-15T10:00:00.000Z
tags:
  - reflection
---

Today was a good day.`

    const parsed = parseJournalEntry(raw, '2026-01-15')

    expect(parsed.hadFrontmatter).toBe(true)
    expect(parsed.frontmatter.id).toBe('j2026-01-15')
    expect(parsed.frontmatter.date).toBe('2026-01-15')
    expect(parsed.frontmatter.tags).toEqual(['reflection'])
    expect(parsed.content).toBe('Today was a good day.')
  })

  it('T379: generates missing fields for content without frontmatter', () => {
    const raw = 'Just some content'

    const parsed = parseJournalEntry(raw, '2026-01-15')

    expect(parsed.hadFrontmatter).toBe(false)
    expect(parsed.frontmatter.id).toBe('j2026-01-15')
    expect(parsed.frontmatter.date).toBe('2026-01-15')
    expect(parsed.frontmatter.created).toBe(FIXED_ISO)
    expect(parsed.frontmatter.modified).toBe(FIXED_ISO)
    expect(parsed.content).toBe('Just some content')
  })

  it('T379: normalizes single tag to array', () => {
    const raw = `---
tags: single-tag
---

Content`

    const parsed = parseJournalEntry(raw, '2026-01-15')

    expect(parsed.frontmatter.tags).toEqual(['single-tag'])
  })

  it('T379: generates ID if missing', () => {
    const raw = `---
date: 2026-01-15
---

Content`

    const parsed = parseJournalEntry(raw, '2026-01-15')

    expect(parsed.frontmatter.id).toBe('j2026-01-15')
  })
})

// ============================================================================
// serializeJournalEntry Tests (T379)
// ============================================================================

describe('serializeJournalEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('T379: serializes frontmatter and content', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: '2026-01-15T08:00:00.000Z',
      modified: '2026-01-15T08:00:00.000Z',
      tags: ['daily']
    }

    const result = serializeJournalEntry(frontmatter, 'Journal content')

    expect(result).toContain('j2026-01-15')
    expect(result).toContain('2026-01-15')
    expect(result).toContain('Journal content')
    // Modified should be updated to current time
    expect(result).toContain(FIXED_ISO)
  })

  it('T379: trims content', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO
    }

    const result = serializeJournalEntry(frontmatter, '  Padded content  \n\n')

    expect(result).toContain('Padded content')
    expect(result).not.toContain('  Padded')
  })
})

// ============================================================================
// extractJournalProperties Tests
// ============================================================================

describe('extractJournalProperties', () => {
  it('extracts properties from explicit properties object', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['daily'],
      properties: {
        mood: 'happy',
        energy: 5,
        weather: 'sunny'
      }
    }

    const result = extractJournalProperties(frontmatter)

    expect(result).toEqual({
      mood: 'happy',
      energy: 5,
      weather: 'sunny'
    })
  })

  it('extracts top-level properties when no explicit properties object', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['daily'],
      mood: 'happy',
      energy: 5
    }

    const result = extractJournalProperties(frontmatter)

    expect(result).toEqual({
      mood: 'happy',
      energy: 5
    })
  })

  it('ignores reserved frontmatter keys', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['daily'],
      customProp: 'value'
    }

    const result = extractJournalProperties(frontmatter)

    expect(result).toEqual({ customProp: 'value' })
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('date')
    expect(result).not.toHaveProperty('created')
    expect(result).not.toHaveProperty('modified')
    expect(result).not.toHaveProperty('tags')
  })

  it('excludes emoji from extracted properties (regression: emoji leak on sync)', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      emoji: '🎉'
    }

    expect(extractJournalProperties(frontmatter)).toBeUndefined()
  })

  it('excludes emoji but keeps custom keys in fallback extraction', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      emoji: '📝',
      mood: 'happy'
    }

    const result = extractJournalProperties(frontmatter)
    expect(result).toEqual({ mood: 'happy' })
    expect(result).not.toHaveProperty('emoji')
  })

  it('returns undefined for frontmatter with no custom properties', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      tags: ['daily']
    }

    const result = extractJournalProperties(frontmatter)

    expect(result).toBeUndefined()
  })

  it('returns undefined for empty properties object', () => {
    const frontmatter = {
      id: 'j2026-01-15',
      date: '2026-01-15',
      created: FIXED_ISO,
      modified: FIXED_ISO,
      properties: {}
    }

    const result = extractJournalProperties(frontmatter)

    expect(result).toBeUndefined()
  })
})

// ============================================================================
// createJournalFrontmatter Tests (T380)
// ============================================================================

describe('createJournalFrontmatter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('T380: creates frontmatter with j-prefixed ID', () => {
    const frontmatter = createJournalFrontmatter('2026-01-15')

    expect(frontmatter.id).toBe('j2026-01-15')
    expect(frontmatter.date).toBe('2026-01-15')
    expect(frontmatter.created).toBe(FIXED_ISO)
    expect(frontmatter.modified).toBe(FIXED_ISO)
    expect(frontmatter.tags).toEqual([])
  })

  it('T380: includes tags when provided', () => {
    const frontmatter = createJournalFrontmatter('2026-01-15', ['mood', 'work'])

    expect(frontmatter.tags).toEqual(['mood', 'work'])
  })
})

// ============================================================================
// File Operations Tests (T381-T382)
// ============================================================================

describe('journal file operations', () => {
  let tempVault: TestDir
  let mockGetStatus: ReturnType<typeof vi.fn>
  let mockGetConfig: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempVault = createTempVault()

    // Get the mock functions and update their return values
    const indexModule = await import('./index')
    mockGetStatus = indexModule.getStatus as ReturnType<typeof vi.fn>
    mockGetConfig = indexModule.getConfig as ReturnType<typeof vi.fn>

    mockGetStatus.mockReturnValue({ path: tempVault.path, isOpen: true })
    mockGetConfig.mockReturnValue({
      journalFolder: 'journal',
      defaultNoteFolder: 'notes',
      attachmentsFolder: 'attachments',
      excludePatterns: []
    })

    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_ISO))
  })

  afterEach(() => {
    vi.useRealTimers()
    tempVault.cleanup()
  })

  describe('readJournalEntry', () => {
    it('T381: reads existing journal entry', async () => {
      // Create a journal file
      const journalPath = path.join(tempVault.path, 'journal', '2026-01-15.md')
      fs.writeFileSync(
        journalPath,
        `---
id: j2026-01-15
date: 2026-01-15
created: 2026-01-15T08:00:00.000Z
modified: 2026-01-15T10:00:00.000Z
tags:
  - daily
---

Today I worked on tests.`
      )

      const entry = await readJournalEntry('2026-01-15')

      expect(entry).not.toBeNull()
      expect(entry!.id).toBe('j2026-01-15')
      expect(entry!.date).toBe('2026-01-15')
      expect(entry!.content).toBe('Today I worked on tests.')
      expect(entry!.tags).toEqual(['daily'])
      expect(entry!.wordCount).toBe(5)
    })

    it('T381: returns null for non-existent entry', async () => {
      const entry = await readJournalEntry('2026-12-31')

      expect(entry).toBeNull()
    })
  })

  describe('writeJournalEntry', () => {
    it('T381: creates new journal entry', async () => {
      const entry = await writeJournalEntry('2026-01-15', 'New journal entry', ['test'])

      expect(entry.id).toBe('j2026-01-15')
      expect(entry.content).toBe('New journal entry')
      expect(entry.tags).toEqual(['test'])

      // Verify file was written
      const filePath = path.join(tempVault.path, 'journal', '2026-01-15.md')
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it('T381: updates existing journal entry', async () => {
      // First write
      await writeJournalEntry('2026-01-15', 'First version')

      // Second write
      const entry = await writeJournalEntry('2026-01-15', 'Updated version', ['updated'])

      expect(entry.content).toBe('Updated version')
      expect(entry.tags).toEqual(['updated'])
    })

    it('T381: preserves created timestamp on update', async () => {
      // Create initial entry
      const initial = await writeJournalEntry('2026-01-15', 'Initial')
      const createdAt = initial.createdAt

      // Advance time
      vi.setSystemTime(new Date('2026-01-16T12:00:00.000Z'))

      // Update
      const updated = await writeJournalEntry('2026-01-15', 'Updated')

      expect(updated.createdAt).toBe(createdAt)
      expect(updated.modifiedAt).not.toBe(createdAt)
    })
  })

  describe('deleteJournalEntryFile', () => {
    it('T382: deletes existing entry', async () => {
      // Create entry
      await writeJournalEntry('2026-01-15', 'To delete')

      const deleted = await deleteJournalEntryFile('2026-01-15')

      expect(deleted).toBe(true)
      const filePath = path.join(tempVault.path, 'journal', '2026-01-15.md')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('T382: returns false for non-existent entry', async () => {
      const deleted = await deleteJournalEntryFile('2026-12-31')

      expect(deleted).toBe(false)
    })
  })

  describe('journalEntryExists', () => {
    it('T382: returns true for existing entry', async () => {
      await writeJournalEntry('2026-01-15', 'Content')

      expect(await journalEntryExists('2026-01-15')).toBe(true)
    })

    it('T382: returns false for non-existent entry', async () => {
      expect(await journalEntryExists('2026-12-31')).toBe(false)
    })
  })
})

// ============================================================================
// calculateActivityLevelFromContent Tests (T383)
// ============================================================================

describe('calculateActivityLevelFromContent', () => {
  it('T383: returns 0 for empty content', () => {
    expect(calculateActivityLevelFromContent('')).toBe(0)
  })

  it('T383: returns higher level for more content', () => {
    const short = 'Short'
    const medium = 'A'.repeat(200)
    const long = 'A'.repeat(1000)

    const shortLevel = calculateActivityLevelFromContent(short)
    const mediumLevel = calculateActivityLevelFromContent(medium)
    const longLevel = calculateActivityLevelFromContent(long)

    expect(shortLevel).toBeLessThanOrEqual(mediumLevel)
    expect(mediumLevel).toBeLessThanOrEqual(longLevel)
  })
})

// ============================================================================
// extractPreview Tests (T383)
// ============================================================================

describe('extractPreview', () => {
  it('T383: removes markdown headers', () => {
    const content = '# Header\n## Subheader\nText here'

    const preview = extractPreview(content)

    expect(preview).not.toContain('#')
    expect(preview).toContain('Text here')
  })

  it('T383: removes markdown links but keeps text', () => {
    const content = 'Check out [this link](https://example.com) for more.'

    const preview = extractPreview(content)

    expect(preview).toContain('this link')
    expect(preview).not.toContain('[')
    expect(preview).not.toContain('](')
  })

  it('T383: removes wiki-links', () => {
    const content = 'See [[Note]] and [[Other|Display]]'

    const preview = extractPreview(content)

    expect(preview).not.toContain('[[')
    expect(preview).not.toContain(']]')
  })

  it('T383: removes images', () => {
    const content = 'Before ![alt text](image.png) After'

    const preview = extractPreview(content)

    expect(preview).not.toContain('![')
    expect(preview).toContain('Before')
    expect(preview).toContain('After')
  })

  it('T383: removes bold and italic markers', () => {
    const content = 'This is **bold** and _italic_ and ***both***'

    const preview = extractPreview(content)

    expect(preview).not.toContain('*')
    expect(preview).not.toContain('_')
    expect(preview).toContain('bold')
    expect(preview).toContain('italic')
  })

  it('T383: truncates long content with ellipsis', () => {
    const content = 'A'.repeat(200)

    const preview = extractPreview(content, 50)

    expect(preview.length).toBeLessThanOrEqual(53) // 50 + '...'
    expect(preview).toContain('...')
  })

  it('T383: returns full content when shorter than max', () => {
    const content = 'Short text'

    const preview = extractPreview(content, 100)

    expect(preview).toBe('Short text')
    expect(preview).not.toContain('...')
  })

  it('T383: collapses whitespace', () => {
    const content = 'Multiple   spaces\n\nand\nnewlines'

    const preview = extractPreview(content)

    expect(preview).toBe('Multiple spaces and newlines')
  })
})
