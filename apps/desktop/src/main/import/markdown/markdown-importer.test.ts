/**
 * Integration test for the Markdown importer orchestrator.
 * Runs against a fixture folder and a real temp vault + databases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'

vi.mock('electron', () => {
  const send = vi.fn()
  return {
    BrowserWindow: { getAllWindows: vi.fn(() => [{ webContents: { send } }]) },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'sample')
const EMBED_FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'wiki-embeds')
// Mirrors a Capacities/Obsidian export: notes in one folder, media in a sibling
// folder, referenced as `../Images/Media/…` from the note.
const NESTED_ASSETS_DIR = path.join(__dirname, '__fixtures__', 'nested-assets')

describe('markdownImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./markdown-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('markdown-import-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()

    vaultIndex = await import('../../vault/index')
    database = await import('../../database')

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
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./markdown-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('imports folder: correct vault folders, frontmatter → tags/properties, attachment saved + link rewritten', async () => {
    const ctx = importContext.createImportContext('it1', new AbortController().signal)
    const summary = await importer.markdownImporter.run({ sourcePaths: [FIXTURE_DIR] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(2)
    expect(summary.attachments).toBe(1)

    // root-note.md → Markdown/
    const rootNote = path.join(tempVault.notesDir, 'Markdown', 'Root Note.md')
    expect(fs.existsSync(rootNote)).toBe(true)
    const rootContent = fs.readFileSync(rootNote, 'utf8')
    // Tags preserved
    expect(rootContent).toContain('work')
    expect(rootContent).toContain('home')
    // Custom property preserved
    expect(rootContent).toContain('status')
    expect(rootContent).toContain('done')
    // Wikilink preserved as-is
    expect(rootContent).toContain('[[wikilink]]')
    // Image link rewritten to vault attachment path
    expect(rootContent).toContain('memry-file://')
    expect(rootContent).not.toContain('](image.png)')

    // work/nested-note.md → Markdown/work/
    const nestedNote = path.join(tempVault.notesDir, 'Markdown', 'work', 'nested-note.md')
    expect(fs.existsSync(nestedNote)).toBe(true)
  })

  it('imports a single file directly', async () => {
    const singleFile = path.join(FIXTURE_DIR, 'root-note.md')
    const ctx = importContext.createImportContext('it2', new AbortController().signal)
    const summary = await importer.markdownImporter.run({ sourcePaths: [singleFile] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    expect(summary.attachments).toBe(1)

    const rootNote = path.join(tempVault.notesDir, 'Markdown', 'Root Note.md')
    expect(fs.existsSync(rootNote)).toBe(true)
  })

  it('saves obsidian `![[image.png]]` embeds as attachments and rewrites the token', async () => {
    const ctx = importContext.createImportContext('it5', new AbortController().signal)
    const summary = await importer.markdownImporter.run({ sourcePaths: [EMBED_FIXTURE_DIR] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    // photo.png is embedded twice but saved once; Images/nested.png is the second.
    expect(summary.attachments).toBe(2)

    const note = path.join(tempVault.notesDir, 'Markdown', 'Embed Note.md')
    expect(fs.existsSync(note)).toBe(true)
    const content = fs.readFileSync(note, 'utf8')

    // Every embed form is replaced by the saved attachment, size hint and all.
    expect(content).not.toContain('![[photo.png]]')
    expect(content).not.toContain('![[photo.png|300x200]]')
    expect(content).not.toContain('![[Images/nested.png]]')
    expect(content.match(/!\[photo\.png]\(memry-file:\/\//g)).toHaveLength(2)
    expect(content).toContain('![nested.png](memry-file://')

    // Note links and note transclusions are not assets and stay untouched.
    expect(content).toContain('[[wikilink]]')
    expect(content).toContain('![[Some Note]]')
  })

  it('copies an asset referenced above the note but inside the selected folder', async () => {
    const ctx = importContext.createImportContext('it6', new AbortController().signal)
    const summary = await importer.markdownImporter.run({ sourcePaths: [NESTED_ASSETS_DIR] }, ctx)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    expect(summary.attachments).toBe(1)
    expect(summary.skipped).toBe(0)

    const note = path.join(tempVault.notesDir, 'Markdown', 'Notes', 'People', 'Person Note.md')
    expect(fs.existsSync(note)).toBe(true)
    const content = fs.readFileSync(note, 'utf8')
    expect(content).toContain('memry-file://')
    expect(content).not.toContain('](../Images/Media/shared.png)')
  })

  it('still rejects an asset that escapes the selected folder', async () => {
    // Selecting only the notes sub-folder puts the media outside the granted
    // root — the traversal guard must keep skipping it.
    const ctx = importContext.createImportContext('it7', new AbortController().signal)
    const summary = await importer.markdownImporter.run(
      { sourcePaths: [path.join(NESTED_ASSETS_DIR, 'Notes', 'People')] },
      ctx
    )

    expect(summary.imported).toBe(1)
    expect(summary.attachments).toBe(0)
    expect(summary.skipped).toBe(1)

    const note = path.join(tempVault.notesDir, 'Markdown', 'Person Note.md')
    expect(fs.readFileSync(note, 'utf8')).toContain('](../Images/Media/shared.png)')
  })

  it('copies an asset from a folder whose name merely starts with dots', async () => {
    // `path.relative` returns `..media/shared.png` for a sibling folder named
    // `..media` — inside the root, even though it opens with two dots.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-import-dots-'))
    try {
      fs.mkdirSync(path.join(root, '..media'))
      fs.writeFileSync(path.join(root, '..media', 'shared.png'), Buffer.from([0x89, 0x50]))
      fs.mkdirSync(path.join(root, 'Notes'))
      fs.writeFileSync(
        path.join(root, 'Notes', 'dotted.md'),
        '# Dotted\n\n![shared](../..media/shared.png)\n'
      )

      const ctx = importContext.createImportContext('it8', new AbortController().signal)
      const summary = await importer.markdownImporter.run({ sourcePaths: [root] }, ctx)

      expect(summary.failed).toEqual([])
      expect(summary.imported).toBe(1)
      expect(summary.attachments).toBe(1)
      expect(summary.skipped).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Directory symlinks need elevation on Windows; the guard itself is platform-agnostic.
  it.skipIf(process.platform === 'win32')(
    'rejects an asset reached through a symlink that leaves the selected folder',
    async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-import-outside-'))
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-import-symlink-'))
      try {
        fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from([0x89, 0x50]))
        // `Images` looks like a folder inside the selection, but everything
        // under it lands outside the root once the link is resolved.
        fs.symlinkSync(outside, path.join(root, 'Images'), 'dir')
        fs.mkdirSync(path.join(root, 'Notes'))
        fs.writeFileSync(
          path.join(root, 'Notes', 'linked.md'),
          '# Linked\n\n![secret](../Images/secret.png)\n'
        )

        const ctx = importContext.createImportContext('it9', new AbortController().signal)
        const summary = await importer.markdownImporter.run({ sourcePaths: [root] }, ctx)

        expect(summary.failed).toEqual([])
        expect(summary.imported).toBe(1)
        expect(summary.attachments).toBe(0)
        expect(summary.skipped).toBe(1)

        const note = path.join(tempVault.notesDir, 'Markdown', 'Notes', 'linked.md')
        expect(fs.readFileSync(note, 'utf8')).toContain('](../Images/secret.png)')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
        fs.rmSync(outside, { recursive: true, force: true })
      }
    }
  )

  it('stops early when cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('it3', ac.signal)
    const summary = await importer.markdownImporter.run({ sourcePaths: [FIXTURE_DIR] }, ctx)
    expect(summary.imported).toBe(0)
  })

  it('frontmatter title overrides filename-derived title', async () => {
    const ctx = importContext.createImportContext('it4', new AbortController().signal)
    await importer.markdownImporter.run({ sourcePaths: [FIXTURE_DIR] }, ctx)

    // root-note.md has title: "Root Note" in frontmatter — the title now lives
    // in the filename and the note cache, never in the file's frontmatter.
    const rootNote = path.join(tempVault.notesDir, 'Markdown', 'Root Note.md')
    expect(fs.existsSync(rootNote)).toBe(true)
    expect(fs.readFileSync(rootNote, 'utf8')).not.toContain('title:')

    const row = indexDb.sqlite
      .prepare('SELECT title FROM note_cache WHERE path = ?')
      .get('notes/Markdown/Root Note.md') as { title: string } | undefined
    expect(row?.title).toBe('Root Note')
  })
})
