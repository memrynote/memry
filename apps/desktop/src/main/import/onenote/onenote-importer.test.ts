/**
 * Integration tests for the OneNote importer.
 *
 * Covers (1) the config-gap path (no Azure client id → clear failure, 0
 * notes), (2) a happy path with `fetch` fully mocked (NO live auth) that walks
 * the Graph tree — section groups included — and exercises every conversion:
 * tags/to-dos, code, styles, math, internal links, video embeds, remote +
 * data-URI images, file attachments (native / extra / blocked), InkML → SVG,
 * subpage nesting, timestamps; and (3) the options: section selection,
 * skip-previously-imported, include-incompatible-attachments, cancellation.
 *
 * The vault/db harness mirrors the Notion importer integration test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
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

// 1x1 transparent PNG, base64.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

const BOUNDARY = '--MultipartBoundary_test'

const INKML = `<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML">
  <inkml:trace>10 10, 20 20, 30 30</inkml:trace>
</inkml:ink>`

const RICH_PAGE_HTML = `<html><head><title>Hello Page</title></head><body>
<h1>Hello Page</h1>
<p>Body text</p>
<p data-tag="to-do">Buy milk</p>
<p data-tag="important">Remember this</p>
<p>Inline <span style="font-family:Consolas">npm test</span> and <span style="font-weight:bold">bold</span></p>
<p><a href="onenote:https://d.docs.live.net/x#page-id={2}&end">Linked page</a></p>
<p><math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p>
<iframe src="https://www.youtube.com/embed/xyz"></iframe>
<img alt="pasted" src="data:image/png;base64,${PNG_BASE64}">
<img alt="OCR words here" src="https://graph.microsoft.com/v1.0/me/onenote/resources/img1/$value" data-fullres-src="https://graph.microsoft.com/v1.0/me/onenote/resources/img1full/$value" data-fullres-src-type="image/png">
<object data-attachment="report.pdf" data="https://graph.microsoft.com/v1.0/me/onenote/resources/file1/$value" type="application/pdf"/>
<object data-attachment="slides.ppt" data="https://graph.microsoft.com/v1.0/me/onenote/resources/file2/$value" type="application/vnd.ms-powerpoint"/>
<object data-attachment="tool.exe" data="https://graph.microsoft.com/v1.0/me/onenote/resources/file3/$value" type="application/octet-stream"/>
</body></html>`

function multipartContent(html: string, inkml?: string): string {
  const parts = [BOUNDARY, 'Content-Type: text/html', '', html]
  if (inkml) {
    parts.push(BOUNDARY, 'Content-Type: application/inkml+xml', '', inkml)
  }
  parts.push(`${BOUNDARY}--`, '')
  return parts.join('\r\n')
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

/** Graph fetch mock: Work notebook (Ideas section + Archive group → Old section). */
function graphFetchMock(url: string): Response {
  if (url.includes('/notebooks?')) {
    return json({ value: [{ id: 'nb1', displayName: 'Work' }] })
  }
  if (url.includes('/notebooks/nb1/sections')) {
    return json({ value: [{ id: 's1', displayName: 'Ideas' }] })
  }
  if (url.includes('/notebooks/nb1/sectionGroups')) {
    return json({ value: [{ id: 'g1', displayName: 'Archive' }] })
  }
  if (url.includes('/sectionGroups/g1/sections')) {
    return json({ value: [{ id: 's2', displayName: 'Old' }] })
  }
  if (url.includes('/sectionGroups/g1/sectionGroups')) {
    return json({ value: [] })
  }
  if (url.includes('/sections/s1/pages')) {
    return json({
      value: [
        {
          id: 'p1',
          title: 'Hello Page',
          createdDateTime: '2024-03-05T10:00:00Z',
          lastModifiedDateTime: '2024-04-06T11:00:00Z',
          level: 0
        },
        { id: 'p1a', title: 'Hello Child', level: 1 }
      ]
    })
  }
  if (url.includes('/sections/s2/pages')) {
    return json({ value: [{ id: 'p2', title: 'Archived Note', level: 0 }] })
  }
  if (url.includes('/pages/p1/content')) {
    return new Response(multipartContent(RICH_PAGE_HTML, INKML), { status: 200 })
  }
  if (url.includes('/pages/p1a/content')) {
    return new Response('<html><body><p>child body</p></body></html>', { status: 200 })
  }
  if (url.includes('/pages/p2/content')) {
    return new Response('<html><body><p>archived body</p></body></html>', { status: 200 })
  }
  if (url.includes('/resources/img1full/')) {
    return new Response(PNG_BYTES, { status: 200 })
  }
  if (url.includes('/resources/file1/') || url.includes('/resources/file2/')) {
    return new Response(Buffer.from('file-bytes'), { status: 200 })
  }
  throw new Error(`unexpected url ${url}`)
}

const TEST_DEPS = {
  clientId: 'test-client-id',
  getAccessToken: async () => 'fake-token',
  fetch: async (url: string) => graphFetchMock(url)
}

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
    const originalClientId = process.env.ONENOTE_CLIENT_ID
    delete process.env.ONENOTE_CLIENT_ID
    try {
      const ctx = importContext.createImportContext('og1', new AbortController().signal)
      const summary = await importer.onenoteImporter.run({ sourcePaths: [] }, ctx)

      expect(summary.imported).toBe(0)
      expect(summary.failed).toHaveLength(1)
      expect(summary.failed[0].item).toBe('OneNote')
      expect(summary.failed[0].error).toMatch(/not yet configured/i)
      expect(fs.existsSync(path.join(tempVault.notesDir, 'OneNote'))).toBe(false)
    } finally {
      if (originalClientId !== undefined) process.env.ONENOTE_CLIENT_ID = originalClientId
    }
  })

  it('imports the full tree with tags, code, math, attachments and ink (fetch mocked)', async () => {
    const ctx = importContext.createImportContext('og2', new AbortController().signal)
    const summary = await importer.runOneNoteImportWithDeps({ sourcePaths: [] }, ctx, TEST_DEPS)

    expect(summary.failed).toEqual([])
    expect(summary.imported).toBe(3)
    // data-URI image + remote image + report.pdf + ink SVG (ppt blocked by
    // default, exe always blocked).
    expect(summary.attachments).toBe(4)
    expect(summary.skipped).toBe(2)

    const base = path.join(tempVault.notesDir, 'OneNote', 'Work')
    // Subpage nesting: parent moves into its own folder with its child.
    const helloPath = path.join(base, 'Ideas', 'Hello Page', 'Hello Page.md')
    const childPath = path.join(base, 'Ideas', 'Hello Page', 'Hello Child.md')
    // Section-group section lands under the group path.
    const archivedPath = path.join(base, 'Archive', 'Old', 'Archived Note.md')
    expect(fs.existsSync(helloPath)).toBe(true)
    expect(fs.existsSync(childPath)).toBe(true)
    expect(fs.existsSync(archivedPath)).toBe(true)

    const content = fs.readFileSync(helloPath, 'utf8')

    // Note tags land in frontmatter; to-dos become task lines.
    expect(content).toMatch(/^---\n[\s\S]*important[\s\S]*---/)
    expect(content).toContain('- [ ] Buy milk')

    // Headings + body survive.
    expect(content).toContain('# Hello Page')
    expect(content).toContain('Body text')

    // Inline code, bold, math, video embed, unwrapped internal link.
    expect(content).toContain('`npm test`')
    expect(content).toContain('**bold**')
    expect(content).toContain('$\\frac{1}{2}$')
    expect(content).toContain('[Embedded video](https://www.youtube.com/embed/xyz)')
    expect(content).toContain('Linked page')
    expect(content).not.toContain('onenote:')

    // Images embed from the vault; the OCR alt survived sanitized.
    expect(content).toContain('![pasted](memry-file://')
    expect(content).toContain('![OCR words here](memry-file://')
    expect(content).not.toContain('](onenote-img-0)')
    expect(content).not.toContain('graph.microsoft.com')

    // The pdf became a clickable file block; ink became a trailing SVG embed.
    expect(content).toContain('<!-- file:')
    expect(content).toContain('report.pdf')
    expect(content).toContain('- Ink.svg')

    // Attachment files exist on disk under the note's attachment folder.
    const attachmentsDir = path.join(tempVault.path, 'attachments')
    const attachmentFiles = fs
      .readdirSync(attachmentsDir, { recursive: true })
      .map((f) => String(f))
    expect(attachmentFiles.some((f) => f.endsWith('.pdf'))).toBe(true)
    expect(attachmentFiles.some((f) => f.endsWith('.svg'))).toBe(true)
    expect(attachmentFiles.some((f) => f.endsWith('.ppt'))).toBe(false)

    // The vault sidecar remembers every imported page.
    const state = JSON.parse(
      fs.readFileSync(path.join(tempVault.path, '.memry', 'import', 'onenote.json'), 'utf8')
    )
    expect(Object.keys(state.importedPageIds).sort()).toEqual(['p1', 'p1a', 'p2'])
  })

  it('skips previously imported pages on a second run (and can be told not to)', async () => {
    const first = importContext.createImportContext('og3', new AbortController().signal)
    await importer.runOneNoteImportWithDeps({ sourcePaths: [] }, first, TEST_DEPS)

    const second = importContext.createImportContext('og4', new AbortController().signal)
    const secondSummary = await importer.runOneNoteImportWithDeps(
      { sourcePaths: [] },
      second,
      TEST_DEPS
    )
    expect(secondSummary.imported).toBe(0)
    // 3 pages skipped as previously imported (no attachment skips: pages are
    // never fetched).
    expect(secondSummary.skipped).toBe(3)

    const third = importContext.createImportContext('og5', new AbortController().signal)
    const thirdSummary = await importer.runOneNoteImportWithDeps(
      { sourcePaths: [], options: { skipPreviouslyImported: false } },
      third,
      TEST_DEPS
    )
    expect(thirdSummary.imported).toBe(3)
  })

  it('imports only the selected sections', async () => {
    const ctx = importContext.createImportContext('og6', new AbortController().signal)
    const summary = await importer.runOneNoteImportWithDeps(
      { sourcePaths: [], options: { sectionIds: ['s2'] } },
      ctx,
      TEST_DEPS
    )
    expect(summary.imported).toBe(1)
    expect(fs.existsSync(path.join(tempVault.notesDir, 'OneNote', 'Work', 'Archive', 'Old'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(tempVault.notesDir, 'OneNote', 'Work', 'Ideas'))).toBe(false)
  })

  it('imports extra attachment types when includeIncompatibleAttachments is on', async () => {
    const ctx = importContext.createImportContext('og7', new AbortController().signal)
    const summary = await importer.runOneNoteImportWithDeps(
      { sourcePaths: [], options: { includeIncompatibleAttachments: true } },
      ctx,
      TEST_DEPS
    )
    expect(summary.failed).toEqual([])
    // ppt now imports too; exe stays out (never allowed).
    expect(summary.attachments).toBe(5)
    expect(summary.skipped).toBe(1)

    const attachmentFiles = fs
      .readdirSync(path.join(tempVault.path, 'attachments'), { recursive: true })
      .map((f) => String(f))
    expect(attachmentFiles.some((f) => f.endsWith('.ppt'))).toBe(true)
    expect(attachmentFiles.some((f) => f.endsWith('.exe'))).toBe(false)
  })

  it('stops early when cancelled before any work', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = importContext.createImportContext('og8', ac.signal)
    const summary = await importer.runOneNoteImportWithDeps({ sourcePaths: [] }, ctx, {
      ...TEST_DEPS,
      fetch: async () => json({ value: [] })
    })
    expect(summary.imported).toBe(0)
  })
})
