/**
 * Resolution of Obsidian image embeds against a real temp vault + index db.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))

describe('resolveVaultEmbed', () => {
  let tempVault: TestVaultResult
  let indexDb: TestDatabaseResult
  let vaultIndex: typeof import('./index')
  let database: typeof import('../database')
  let resolver: typeof import('./resolve-embed')

  const writeVaultFile = (relPath: string): string => {
    const abs = path.join(tempVault.path, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'x')
    return abs
  }

  beforeEach(async () => {
    tempVault = createTestVault('resolve-embed-test')
    indexDb = createTestIndexDb()

    vaultIndex = await import('./index')
    database = await import('../database')

    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: [],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)

    resolver = await import('./resolve-embed')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    indexDb.close()
    tempVault.cleanup()
  })

  it('resolves a vault-root-relative target to a memry-file URL', () => {
    writeVaultFile('Images/photo.png')
    const url = resolver.resolveVaultEmbed('Images/photo.png')
    expect(url).toMatch(/^memry-file:\/\/local\//)
    expect(url).toContain('photo.png')
  })

  // Whatever this returns is spliced into the note's markdown, so it is also
  // what gets written back to the vault file on the next save. Given the note's
  // own path it must stay portable — no absolute, machine-specific prefix in a
  // file that syncs to other devices and is meant to stay readable in Obsidian.
  describe('given the note path', () => {
    it('returns a target relative to the note, not an absolute URL', () => {
      writeVaultFile('Images/photo.png')
      const target = resolver.resolveVaultEmbed('Images/photo.png', 'People/Person.md')
      expect(target).toBe('../Images/photo.png')
    })

    it('resolves a sibling file without any ../ prefix', () => {
      writeVaultFile('People/photo.png')
      expect(resolver.resolveVaultEmbed('People/photo.png', 'People/Person.md')).toBe('photo.png')
    })

    it('keeps a note at the vault root simple', () => {
      writeVaultFile('Images/photo.png')
      expect(resolver.resolveVaultEmbed('Images/photo.png', 'Root.md')).toBe('Images/photo.png')
    })

    it('encodes characters that would break the markdown link', () => {
      writeVaultFile('Images/my photo (1).png')
      expect(resolver.resolveVaultEmbed('Images/my photo (1).png', 'Root.md')).toBe(
        'Images/my%20photo%20%281%29.png'
      )
    })

    it('still resolves a bare filename found by index lookup', () => {
      writeVaultFile('Images/nested.png')
      indexDb.sqlite
        .prepare(
          `INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
           VALUES (?, ?, ?, 'image', 0, 0)`
        )
        .run('img1', 'Images/nested.png', 'nested')

      expect(resolver.resolveVaultEmbed('nested.png', 'People/Person.md')).toBe(
        '../Images/nested.png'
      )
    })
  })

  it('falls back to an absolute URL when the note path is unknown', () => {
    writeVaultFile('Images/photo.png')
    expect(resolver.resolveVaultEmbed('Images/photo.png')).toMatch(/^memry-file:\/\/local\//)
  })

  it('resolves a target relative to the notes folder', () => {
    writeVaultFile('notes/Media/shot.png')
    expect(resolver.resolveVaultEmbed('Media/shot.png')).toContain('shot.png')
  })

  it('percent-encodes a filename containing spaces', () => {
    writeVaultFile('Images/my photo.png')
    expect(resolver.resolveVaultEmbed('Images/my photo.png')).toContain('my%20photo.png')
  })

  it('returns null for a target that does not exist', () => {
    expect(resolver.resolveVaultEmbed('nope.png')).toBeNull()
  })

  it('refuses a target that climbs out of the vault', () => {
    expect(resolver.resolveVaultEmbed('../../etc/passwd.png')).toBeNull()
  })

  it('refuses an absolute path and a URL', () => {
    expect(resolver.resolveVaultEmbed('/etc/photo.png')).toBeNull()
    expect(resolver.resolveVaultEmbed('https://example.com/photo.png')).toBeNull()
  })

  it('finds a bare filename through the index when it is not at a guessable path', () => {
    writeVaultFile('deep/nested/folder/found.png')
    indexDb.sqlite
      .prepare(
        `INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
         VALUES (?, ?, ?, 'image', 0, 0)`
      )
      .run('img1', 'deep/nested/folder/found.png', 'found')

    expect(resolver.resolveVaultEmbed('found.png')).toContain('found.png')
  })

  it('prefers the shortest path when the filename is ambiguous', () => {
    writeVaultFile('a/dup.png')
    writeVaultFile('a/b/c/dup.png')
    const insert = indexDb.sqlite.prepare(
      `INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
       VALUES (?, ?, 'dup', 'image', 0, 0)`
    )
    insert.run('deep', 'a/b/c/dup.png')
    insert.run('shallow', 'a/dup.png')

    const url = resolver.resolveVaultEmbed('dup.png')
    expect(url).toContain('/a/dup.png')
    expect(url).not.toContain('/b/c/')
  })

  it('resolves nothing while the vault is closed', () => {
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: false,
      path: null,
      isIndexing: false,
      indexProgress: 0,
      error: null
    } as unknown as VaultStatus)
    expect(resolver.resolveVaultEmbed('Images/photo.png')).toBeNull()
  })

  it('batches, omitting the targets it cannot resolve', () => {
    writeVaultFile('Images/photo.png')
    const resolved = resolver.resolveVaultEmbeds(['Images/photo.png', 'missing.png'])
    expect(Object.keys(resolved)).toEqual(['Images/photo.png'])
  })
})
