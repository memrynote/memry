// Note attachments and the file viewer, ported from Electron's `file-attachments-viewer.e2e.ts`
// (#3531 14f-3d):
// - an upload lands in the note's attachments folder, is listed, and is served over `memry-file`
//   as the image it is;
// - an embedded PDF is fetched over `memry-file`, decoded by pdf.js in its worker and painted on
//   a canvas;
// - skipped until #4209: an image file in the vault reopens from a restored tab in the image
//   viewer, and a PDF file in the PDF viewer. The app never lists either file. Electron imported
//   them through `notes.importFiles`, which Step 32 (#3549) ports; here they are written into the
//   vault, where the import would copy them.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  minimalPdfBytes,
  PDF_FILE,
  PNG_BYTES,
  seedNoteWithFileBlock,
  seedVaultFile,
  uploadAttachment
} from '../../harness/attachments'
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Restores one file tab: the session is seeded where the app reads it, then the page reloads. */
async function restoreFileTab(page: Page, fileId: string, title: string): Promise<void> {
  const storageKey = `memry_tab_state:${(await vaultStatus(page)).path}`
  await page.addInitScript(
    ({ id, t, key }: { id: string; t: string; key: string }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          tabGroups: {
            g1: {
              id: 'g1',
              activeTabId: 'file-tab',
              tabs: [
                {
                  id: 'file-tab',
                  type: 'file',
                  title: t,
                  icon: 'file',
                  path: `/file/${id}`,
                  entityId: id,
                  isPinned: false
                }
              ]
            }
          },
          layout: { type: 'leaf', tabGroupId: 'g1' },
          activeGroupId: 'g1',
          settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
          savedAt: Date.now()
        })
      )
    },
    { id: fileId, t: title, key: storageKey }
  )
  await vaultOpen(page)
}

/** The `memry-file` answer for a file: status, type and size. */
const served = (page: Page, absolutePath: string) =>
  page.evaluate(async (path: string) => {
    const encoded = path
      .replaceAll('\\', '/')
      .split('/')
      .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'))
      .join('/')
    const rooted = encoded.startsWith('/') ? encoded : `/${encoded}`
    // Windows serves the scheme from WebView2's https host, with the launch token.
    const url =
      document.documentElement.getAttribute('data-platform') === 'win32'
        ? `https://memry-file.localhost/local${rooted}?t=${window.__MEMRY_SHELL__?.loopbackToken}`
        : `memry-file://local${rooted}`
    const response = await fetch(url)
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      byteLength: (await response.arrayBuffer()).byteLength
    }
  }, absolutePath)

test('uploads a note attachment and serves it over memry-file', async ({ page, testVaultPath }) => {
  await vaultOpen(page)
  const note = await createNote(page, { title: `Attachment Note ${stamp()}`, content: 'host' })
  await uploadAttachment(page, note.id, 'note-attachment.png', PNG_BYTES)
  const listed = await invoke<Array<{ filename: string }>>(page, 'notes_list_attachments', {
    noteId: note.id
  })
  expect(listed.length).toBe(1)
  const folder = join(testVaultPath, 'attachments', note.id)
  expect(readdirSync(folder)).toContain(listed[0].filename)
  expect(await served(page, join(folder, listed[0].filename))).toEqual({
    status: 200,
    contentType: 'image/png',
    byteLength: PNG_BYTES.length
  })
})

test('renders an embedded PDF through the pdf.js worker onto a canvas', async ({ page }) => {
  await vaultOpen(page)
  await seedNoteWithFileBlock(page, `Embedded PDF ${stamp()}`, PDF_FILE)
  // react-pdf paints the page on a canvas only once its worker has decoded the file.
  await expect(page.locator('.pdf-preview canvas').first()).toBeVisible({ timeout: 30_000 })
})

test('restores an image file in its viewer tab', async ({ page, testVaultPath }) => {
  test.skip(true, 'non-markdown vault files are not indexed (#4209)')
  await vaultOpen(page)
  const title = `e2e-import-${stamp()}`
  const image = await seedVaultFile(page, testVaultPath, `${title}.png`, PNG_BYTES)
  expect(image.fileType).toBe('image')
  const file = await invoke<{ absolutePath: string } | null>(page, 'notes_get_file', {
    id: image.id
  })
  expect(await served(page, file!.absolutePath)).toEqual({
    status: 200,
    contentType: 'image/png',
    byteLength: PNG_BYTES.length
  })

  await restoreFileTab(page, image.id, title)
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('img', { name: title })).toBeVisible()
})

test('renders a PDF file in the PDF viewer through the pdf.js worker', async ({
  page,
  testVaultPath
}) => {
  test.skip(true, 'non-markdown vault files are not indexed (#4209)')
  await vaultOpen(page)
  const title = `e2e-pdf-${stamp()}`
  const pdf = await seedVaultFile(page, testVaultPath, `${title}.pdf`, minimalPdfBytes())

  await restoreFileTab(page, pdf.id, title)
  // The toolbar shows page 1 of 1 once pdf.js has loaded the file, and the page is painted on a
  // canvas: both only happen when the worker ran.
  await expect(page.getByTestId('pdf-page-input')).toHaveValue('1', { timeout: 30_000 })
  await expect(page.getByText('/ 1')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
})
