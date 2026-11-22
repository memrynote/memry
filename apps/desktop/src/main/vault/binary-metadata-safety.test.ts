/**
 * #2073 — a non-markdown file in the vault is binary content. Editing its Memry
 * metadata (tags, properties, frontmatter) from the folder table must never
 * decode it as UTF-8, never pass it through the markdown/frontmatter serializer
 * and never replace its bytes.
 *
 * @module vault/binary-metadata-safety.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import type * as IndexModule from './status'
import type * as DatabaseModule from '../database'
import type * as NotesModule from './notes'

vi.mock('electron', () => {
  const mockWebContents = { send: vi.fn() }
  const mockWindow = { isDestroyed: () => false, webContents: mockWebContents }

  return {
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]) },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

/** Minimal but real PDF: header, binary comment line, one object, trailer, EOF. */
const PDF_BYTES = Buffer.from(
  '255044462d312e340a25e2e3cfd30a312030206f626a0a3c3c2f547970652f436174616c6f673e3e0a' +
    '656e646f626a0a747261696c65720a3c3c2f526f6f742031203020523e3e0a2525454f460a',
  'hex'
)

/** A PNG signature plus a chunk of bytes that are not valid UTF-8. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xc0, 0x80, 0x00, 0x01
])

function sha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

describe('binary file metadata safety (#2073)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let testDb: TestDatabaseResult

  let vaultIndex: typeof IndexModule
  let database: typeof DatabaseModule
  let notes: typeof NotesModule

  beforeEach(async () => {
    tempVault = createTestVault('binary-metadata-safety')
    dataDb = createTestDataDb()
    testDb = createTestIndexDb()

    vaultIndex = await import('./status')
    database = await import('../database')
    notes = await import('./notes')

    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getDatabase').mockReturnValue(
      dataDb.db as unknown as ReturnType<typeof database.getDatabase>
    )
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(testDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    testDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  async function seedBinary(
    id: string,
    fileName: string,
    fileType: 'pdf' | 'image',
    bytes: Buffer
  ): Promise<{ absolutePath: string; sha: string }> {
    const absolutePath = path.join(tempVault.notesDir, fileName)
    fs.writeFileSync(absolutePath, bytes)

    const { insertNoteCache } = await import('@main/database/queries/notes')
    insertNoteCache(testDb.db, {
      id,
      path: `notes/${fileName}`,
      title: path.basename(fileName, path.extname(fileName)),
      fileType,
      mimeType: fileType === 'pdf' ? 'application/pdf' : 'image/png',
      fileSize: bytes.length,
      createdAt: '2026-01-15T12:00:00.000Z',
      modifiedAt: '2026-01-15T12:00:00.000Z'
    })

    return { absolutePath, sha: sha256(absolutePath) }
  }

  it('rejects a tag edit on a PDF row and leaves the bytes untouched', async () => {
    const { absolutePath, sha } = await seedBinary('pdf-tag-1', 'invoice.pdf', 'pdf', PDF_BYTES)

    await expect(
      notes.updateNote({ id: 'pdf-tag-1', headerTags: { add: ['invoice'] } })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN' })

    expect(sha256(absolutePath)).toBe(sha)
    expect(Buffer.compare(fs.readFileSync(absolutePath), PDF_BYTES)).toBe(0)
  })

  it('rejects a tag edit on an image row and leaves the bytes untouched', async () => {
    const { absolutePath, sha } = await seedBinary('png-tag-1', 'photo.png', 'image', PNG_BYTES)

    await expect(
      notes.updateNote({ id: 'png-tag-1', headerTags: { add: ['holiday'] } })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN' })

    expect(sha256(absolutePath)).toBe(sha)
    expect(Buffer.compare(fs.readFileSync(absolutePath), PNG_BYTES)).toBe(0)
  })

  it('rejects a tag edit on a markdown-typed row at a .png path (#5412 rows)', async () => {
    const absolutePath = path.join(tempVault.notesDir, 'scan.png')
    fs.writeFileSync(absolutePath, PNG_BYTES)
    const { insertNoteCache } = await import('@main/database/queries/notes')
    insertNoteCache(testDb.db, {
      id: 'png-retyped-1',
      path: 'notes/scan.png',
      title: 'scan',
      fileType: 'markdown',
      createdAt: '2026-01-15T12:00:00.000Z',
      modifiedAt: '2026-01-15T12:00:00.000Z'
    })

    await expect(
      notes.updateNote({ id: 'png-retyped-1', headerTags: { add: ['scan'] } })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN' })

    expect(Buffer.compare(fs.readFileSync(absolutePath), PNG_BYTES)).toBe(0)
  })

  it('rejects a property edit reachable from the same folder table row', async () => {
    const { absolutePath, sha } = await seedBinary('pdf-prop-1', 'report.pdf', 'pdf', PDF_BYTES)

    await expect(
      notes.updateNote({ id: 'pdf-prop-1', properties: { status: 'review' } })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN' })

    expect(sha256(absolutePath)).toBe(sha)
  })

  it('rejects a frontmatter edit on a PDF row', async () => {
    const { absolutePath, sha } = await seedBinary('pdf-fm-1', 'scan.pdf', 'pdf', PDF_BYTES)

    await expect(
      notes.updateNote({ id: 'pdf-fm-1', frontmatter: { aliases: ['scan'] } })
    ).rejects.toMatchObject({ code: 'NOTE_NOT_MARKDOWN' })

    expect(sha256(absolutePath)).toBe(sha)
  })

  it('still lets a markdown note take a tag edit', async () => {
    const created = await notes.createNote({ title: 'Meeting', content: 'Body.' })

    const { note: updated } = await notes.updateNote({
      id: created.id,
      headerTags: { add: ['work'] }
    })

    expect(updated.headerTags).toEqual(['work'])
    const raw = fs.readFileSync(path.join(tempVault.path, created.path), 'utf-8')
    expect(raw).toContain('tags:')
    expect(raw).toContain('- work')
  })

  describe('rows a write-back retyped to markdown at a binary path (#5412, #5422)', () => {
    /** The file `![](pic.png)` names sits beside it, so a move to a subfolder re-points it. */
    const PNG_WITH_TEXT = Buffer.concat([PNG_BYTES, Buffer.from('![](pic.png) [[Old]]')])

    async function seedRetyped(id: string, fileName: string): Promise<string> {
      const absolutePath = path.join(tempVault.notesDir, fileName)
      fs.writeFileSync(absolutePath, PNG_WITH_TEXT)
      const { insertNoteCache } = await import('@main/database/queries/notes')
      insertNoteCache(testDb.db, {
        id,
        path: `notes/${fileName}`,
        title: path.basename(fileName, path.extname(fileName)),
        fileType: 'markdown',
        createdAt: '2026-01-15T12:00:00.000Z',
        modifiedAt: '2026-01-15T12:00:00.000Z'
      })
      return absolutePath
    }

    async function cachedFileType(id: string): Promise<string | null | undefined> {
      const { flushProjectionEvents } = await import('../projections')
      await flushProjectionEvents()
      const { getNoteCacheById } = await import('@main/database/queries/notes')
      return getNoteCacheById(testDb.db, id)?.fileType
    }

    function expectBytesKept(relativePath: string): void {
      const bytes = fs.readFileSync(path.join(tempVault.path, relativePath))
      expect(Buffer.compare(bytes, PNG_WITH_TEXT)).toBe(0)
    }

    it('rename keeps the bytes and files the row as an image', async () => {
      await seedRetyped('retyped-rename', 'scan.png')

      const renamed = await notes.renameNote('retyped-rename', 'Receipt')

      expect(renamed.path).toBe('notes/Receipt.png')
      expectBytesKept(renamed.path)
      expect(await cachedFileType('retyped-rename')).toBe('image')
    })

    it('move keeps the bytes and files the row as an image', async () => {
      await seedRetyped('retyped-move', 'scan.png')
      fs.mkdirSync(path.join(tempVault.notesDir, 'sub'))

      const moved = await notes.moveNote('retyped-move', 'notes/sub')

      expect(moved.path).toBe('notes/sub/scan.png')
      expectBytesKept(moved.path)
      expect(await cachedFileType('retyped-move')).toBe('image')
    })

    it('folder move files the row as an image', async () => {
      fs.mkdirSync(path.join(tempVault.notesDir, 'scans'))
      await seedRetyped('retyped-folder', 'scans/scan.png')

      await notes.renameFolder('notes/scans', 'notes/archive')

      expectBytesKept('notes/archive/scan.png')
      expect(await cachedFileType('retyped-folder')).toBe('image')
    })

    it('renaming a note it links to leaves its bytes alone', async () => {
      await seedRetyped('retyped-source', 'scan.png')
      const target = await notes.createNote({ title: 'Old', content: 'Body.' })
      const { sql } = await import('@tests/utils/test-db')
      testDb.db.run(sql`
        INSERT INTO note_links (source_id, target_id, target_title)
        VALUES (${'retyped-source'}, ${target.id}, ${'Old'})
      `)

      await notes.renameNote(target.id, 'New')

      expectBytesKept('notes/scan.png')
    })
  })
})
