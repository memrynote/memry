/**
 * Tests for the OneNote importer.
 *
 * Covers (1) the pure transforms re-exported from `@memry/onenote-import`,
 * (2) the config-gap path (no Azure client id → clear failure, 0 notes), and
 * (3) a happy path with `fetch` fully mocked (NO live auth) that walks the
 * Graph tree and writes a note with an extracted base64 image.
 *
 * The vault/db harness mirrors the Notion importer integration test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { mapTree, preparePageHtml, extractDataImages } from '@memry/onenote-import'
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

// 1x1 transparent PNG, base64.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('onenote pure transforms', () => {
  it('maps notebooks/sections/pages into OneNote folders', () => {
    const plans = mapTree(
      [{ id: 'nb', displayName: 'Notebook A' }],
      [{ id: 's', displayName: 'Section A', notebookId: 'nb' }],
      [{ id: 'p', title: 'Page A', sectionId: 's' }]
    )
    expect(plans).toEqual([
      { pageId: 'p', title: 'Page A', folder: 'OneNote/Notebook A/Section A' }
    ])
  })

  it('prepares page html and extracts base64 images', () => {
    const { html } = preparePageHtml(`<p>hi<object data="x"/></p>`)
    expect(html).toContain('</object>')
    const { images, html: out } = extractDataImages(
      `<img src="data:image/png;base64,${PNG_BASE64}">`
    )
    expect(images).toHaveLength(1)
    expect(out).toContain('src="onenote-img-0"')
  })
})

describe('onenoteImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./onenote-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('onenote-import-test')
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

    importer = await import('./onenote-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('reports a clear failure and creates 0 notes when no client id is configured', async () => {
    const ctx = importContext.createImportContext('og1', new AbortController().signal)
    const summary = await importer.onenoteImporter.run({ sourcePaths: [] }, ctx)

    expect(summary.imported).toBe(0)
    expect(summary.failed).toHaveLength(1)
    expect(summary.failed[0].item).toBe('OneNote')
    expect(summary.failed[0].error).toMatch(/not yet configured/i)
    expect(fs.existsSync(path.join(tempVault.notesDir, 'OneNote'))).toBe(false)
  })

  it('imports a page from converted Graph HTML with an extracted image (fetch mocked)', async () => {
    // Mock the Graph fetch: notebooks → sections → pages → page content.
    const fetchMock = async (url: string): Promise<Response> => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })

      if (url.includes('/notebooks?')) {
        return json({ value: [{ id: 'nb1', displayName: 'Work' }] })
      }
      if (url.includes('/notebooks/nb1/sections')) {
        return json({ value: [{ id: 's1', displayName: 'Ideas' }] })
      }
      if (url.includes('/sections/s1/pages')) {
        return json({
          value: [{ id: 'p1', title: 'Hello Page', createdDateTime: '2024-03-05T10:00:00Z' }]
        })
      }
      if (url.includes('/pages/p1/content')) {
        return new Response(
          `<html><body><h1>Hello Page</h1><p>Body text</p>` +
            `<img alt="pic" src="data:image/png;base64,${PNG_BASE64}"></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
      }
      throw new Error(`unexpected url ${url}`)
    }

    const ctx = importContext.createImportContext('og2', new AbortController().signal)
    const summary = await importer.runOneNoteImportWithDeps({ sourcePaths: [] }, ctx, {
      clientId: 'test-client-id',
      getAccessToken: async () => 'fake-token',
      fetch: (url) => fetchMock(url)
    })

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(1)
    expect(summary.attachments).toBe(1)

    const notePath = path.join(tempVault.notesDir, 'OneNote', 'Work', 'Ideas', 'Hello Page.md')
    expect(fs.existsSync(notePath)).toBe(true)

    const content = fs.readFileSync(notePath, 'utf8')
    expect(content).toContain('# Hello Page')
    expect(content).toContain('Body text')
    // The base64 image placeholder ref was rewritten to a saved vault attachment.
    expect(content).toContain('![pic](memry-file://')
    // No bare placeholder ref should remain (the saved filename keeps the stem).
    expect(content).not.toContain('](onenote-img-0)')
  })

  it('stops early when cancelled before any work', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('og3', ac.signal)
    const summary = await importer.runOneNoteImportWithDeps({ sourcePaths: [] }, ctx, {
      clientId: 'test-client-id',
      getAccessToken: async () => 'fake-token',
      fetch: async () => new Response('{"value":[]}', { status: 200 })
    })
    expect(summary.imported).toBe(0)
  })
})
