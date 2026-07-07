/**
 * Tests for the one-time frontmatter-diet vault migration.
 *
 * @module vault/migrations/frontmatter-diet.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteMetadataByPath } from '@memry/storage-data/note-metadata-repository'
import { getSetting } from '@main/database/queries/settings'

// getConfig lives in the heavy vault/index module — stub it so we don't load
// electron/dialog wiring, and control excludes.
vi.mock('../index', () => ({
  getConfig: vi.fn(() => ({
    excludePatterns: [],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    attachmentsFolder: 'attachments'
  }))
}))

// Journal detection: direct children of journal/ named YYYY-MM-DD.md.
vi.mock('@main/database/queries/notes', () => ({
  extractDateFromPath: (p: string): string | null => {
    const match = /^journal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(p)
    return match ? match[1] : null
  }
}))

function writeFile(vault: TestVaultResult, relPath: string, content: string): void {
  const abs = path.join(vault.path, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

function read(vault: TestVaultResult, relPath: string): string {
  return fs.readFileSync(path.join(vault.path, relPath), 'utf8')
}

describe('frontmatter-diet migration', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let database: typeof import('../../database')
  let migration: typeof import('./frontmatter-diet')

  beforeEach(async () => {
    vault = createTestVault('fm-diet')
    dataDb = createTestDataDb()

    database = await import('../../database')
    migration = await import('./frontmatter-diet')

    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    dataDb.close()
    vault.cleanup()
  })

  it('strips legacy note keys and adopts them into note_metadata', async () => {
    const rel = 'notes/Legacy Note.md'
    writeFile(
      vault,
      rel,
      [
        '---',
        'id: abc123def456',
        'title: Legacy Note',
        'created: 2020-01-02T03:04:05.000Z',
        'modified: 2021-06-07T08:09:10.000Z',
        'emoji: 📓',
        'localOnly: true',
        'tags:',
        '  - work',
        'status: draft',
        '---',
        'Body text'
      ].join('\n')
    )

    const result = await migration.migrateFrontmatterDietIfNeeded(vault.path)
    expect(result.skipped).toBe(false)
    expect(result.filesRewritten).toBe(1)

    const after = read(vault, rel)
    expect(after).not.toMatch(/^id:/m)
    expect(after).not.toMatch(/^title:/m)
    expect(after).not.toMatch(/^created:/m)
    expect(after).not.toMatch(/^modified:/m)
    expect(after).not.toMatch(/^emoji:/m)
    expect(after).not.toMatch(/^localOnly:/m)
    // User keys survive
    expect(after).toMatch(/^status: draft$/m)
    expect(after).toContain('- work')
    expect(after).toContain('Body text')

    const row = getNoteMetadataByPath(dataDb.db, rel)
    expect(row?.id).toBe('abc123def456')
    expect(row?.emoji).toBe('📓')
    expect(row?.localOnly).toBe(true)
    expect(row?.syncPolicy).toBe('local-only')
    expect(row?.createdAt).toBe('2020-01-02T03:04:05.000Z')
  })

  it('keeps date on journals while stripping legacy keys', async () => {
    const rel = 'journal/2026-01-15.md'
    writeFile(
      vault,
      rel,
      [
        '---',
        'id: j2026-01-15',
        'date: 2026-01-15',
        'created: 2026-01-15T00:00:00.000Z',
        'emoji: 📅',
        '---',
        'Journal body'
      ].join('\n')
    )

    await migration.migrateFrontmatterDietIfNeeded(vault.path)

    const after = read(vault, rel)
    expect(after).toMatch(/^date: 2026-01-15$/m)
    expect(after).not.toMatch(/^id:/m)
    expect(after).not.toMatch(/^created:/m)
    expect(after).not.toMatch(/^emoji:/m)
    expect(after).toContain('Journal body')

    const row = getNoteMetadataByPath(dataDb.db, rel)
    expect(row?.journalDate).toBe('2026-01-15')
  })

  it('is idempotent and gated by the settings flag', async () => {
    writeFile(vault, 'notes/A.md', '---\nid: aaaaaaaaaaaa\nemoji: 🅰️\n---\nBody')

    const first = await migration.migrateFrontmatterDietIfNeeded(vault.path)
    expect(first.filesRewritten).toBe(1)
    expect(getSetting(dataDb.db, 'vault.migration.frontmatterDiet')).not.toBeNull()

    const second = await migration.migrateFrontmatterDietIfNeeded(vault.path)
    expect(second.skipped).toBe(true)
    expect(second.filesRewritten).toBe(0)
  })

  it('leaves files without legacy keys untouched', async () => {
    const rel = 'notes/Clean.md'
    const original = '---\ntags:\n  - keep\n---\nAlready clean'
    writeFile(vault, rel, original)

    const result = await migration.migrateFrontmatterDietIfNeeded(vault.path)
    expect(result.filesRewritten).toBe(0)
    expect(read(vault, rel)).toBe(original)
  })
})
